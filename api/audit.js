// POST /api/audit
//
// Starts an audit job immediately and returns a jobId.
// The actual LLM request runs in the background.
//
// GET /api/audit/:jobId
//
// Returns the current job status/result.
//
// NOTE:
// Jobs live in memory only. A Render restart/redeploy will remove
// unfinished jobs. This is intentional for the current lightweight phase.

const crypto = require('crypto');

const jobs = new Map();

const MAX_CHARS = 60000;

// Clean old completed/failed jobs so memory doesn't grow forever.
// Keep jobs for 30 minutes.
const JOB_TTL = 30 * 60 * 1000;

function cleanupJobs() {
  const now = Date.now();

  for (const [id, job] of jobs) {
    if (
      (job.status === 'completed' || job.status === 'failed') &&
      now - job.finishedAt > JOB_TTL
    ) {
      jobs.delete(id);
    }
  }
}

setInterval(cleanupJobs, 5 * 60 * 1000).unref();

async function runAudit(jobId, data) {
  const job = jobs.get(jobId);

  if (!job) return;

  try {
    job.status = 'running';
    job.startedAt = Date.now();

    const {
      source,
      systemPrompt,
      model,
      contractName,
      address,
      llmUrl,
      apiKey
    } = data;

    let src = source;
    let truncated = false;

    if (src.length > MAX_CHARS) {
      src = src.slice(0, MAX_CHARS);
      truncated = true;
    }

    const userMessage =
      `Contract: ${contractName || 'unknown'} (${address || 'unknown address'})\n\n` +
      '```solidity\n' +
      src +
      '\n```' +
      (truncated
        ? '\n\n[NOTE: source was truncated to fit context length]'
        : '');

    const endpoint =
      llmUrl && /^https?:\/\//.test(llmUrl)
        ? llmUrl
        : 'https://api.openai.com/v1/chat/completions';

    console.log(
      `[AUDIT ${jobId}] Sending request to LLM: ${endpoint}`
    );

    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userMessage
          }
        ],
      }),
    });

    const j = await r.json();

    console.log(
  `[AUDIT ${jobId}] LLM HTTP status:`,
  r.status
);

console.log(
  `[AUDIT ${jobId}] LLM RESPONSE:`,
  JSON.stringify(j).slice(0, 10000)
);

    if (!r.ok || j.error) {
      throw new Error(
        j?.error?.message ||
        `LLM request failed with HTTP ${r.status}`
      );
    }

    const text =
  j?.choices?.[0]?.message?.content ||
  j?.choices?.[0]?.text ||
  j?.output_text ||
  '';

if (!text || !String(text).trim()) {
  console.error(
    `[AUDIT ${jobId}] LLM returned empty response:`,
    JSON.stringify(j).slice(0, 5000)
  );

  throw new Error('LLM returned an empty audit response');
}

job.status = 'completed';
job.result = String(text);
job.truncated = truncated;
job.finishedAt = Date.now();

    console.log(
      `[AUDIT ${jobId}] Completed in ${job.finishedAt - job.startedAt}ms`
    );

  } catch (err) {
    job.status = 'failed';

    job.error = String(
      err?.cause?.message ||
      err?.message ||
      err
    );

    console.error(
      `[AUDIT ${jobId}] ERROR DETAILS:`,
      {
        name: err?.name,
        message: err?.message,
        cause: err?.cause
          ? {
              name: err.cause.name,
              message: err.cause.message,
              code: err.cause.code,
              errno: err.cause.errno,
              syscall: err.cause.syscall,
              hostname: err.cause.hostname
            }
          : null
      }
    );

    job.finishedAt = Date.now();
  }
}

module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-openai-key'
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // ------------------------------------------
  // START AUDIT
  // ------------------------------------------

  if (req.method === 'POST') {

    const {
      source,
      systemPrompt,
      model,
      contractName,
      address,
      llmUrl
    } = req.body || {};

    if (!source) {
      return res.status(400).json({
        error: 'source is required'
      });
    }

    if (!systemPrompt) {
      return res.status(400).json({
        error: 'systemPrompt is required'
      });
    }

    const apiKey =
      req.headers['x-openai-key'] ||
      process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error:
          'No OpenAI API key provided (header x-openai-key or OPENAI_API_KEY env var)'
      });
    }

    const jobId = crypto.randomUUID();

    jobs.set(jobId, {
      status: 'queued',
      result: null,
      error: null,
      truncated: false,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null
    });

    // IMPORTANT:
    // Return immediately.
    res.status(202).json({
      jobId,
      status: 'queued'
    });

    // Start the real audit AFTER responding.
    runAudit(jobId, {
      source,
      systemPrompt,
      model,
      contractName,
      address,
      llmUrl,
      apiKey
    });

    return;
  }

  // ------------------------------------------
  // CHECK AUDIT STATUS
  // ------------------------------------------

  if (req.method === 'GET') {

    const jobId = req.params.jobId;

    const job = jobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        error: 'Audit job not found'
      });
    }

    return res.json({
      jobId,
      status: job.status,
      result: job.status === 'completed'
        ? job.result
        : null,
      truncated: job.truncated,
      error: job.status === 'failed'
        ? job.error
        : null,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt
    });
  }

  return res.status(405).json({
    error: 'GET or POST only'
  });
};
