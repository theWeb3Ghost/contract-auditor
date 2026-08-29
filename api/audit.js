
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

// Keep completed/failed jobs for 30 minutes
const JOB_TTL = 30 * 60 * 1000;


// ------------------------------------------
// CLEAN OLD JOBS
// ------------------------------------------

function cleanupJobs() {
  const now = Date.now();

  for (const [id, job] of jobs) {
    if (
      (job.status === 'completed' || job.status === 'failed') &&
      job.finishedAt &&
      now - job.finishedAt > JOB_TTL
    ) {
      jobs.delete(id);
    }
  }
}

setInterval(cleanupJobs, 5 * 60 * 1000).unref();


// ------------------------------------------
// RUN AUDIT IN BACKGROUND
// ------------------------------------------

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


    // ------------------------------------------
    // PREPARE CONTRACT SOURCE
    // ------------------------------------------

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
      (
        truncated
          ? '\n\n[NOTE: source was truncated to fit context length]'
          : ''
      );


    // ------------------------------------------
    // DETERMINE LLM ENDPOINT
    // ------------------------------------------

    const endpoint =
      llmUrl && /^https?:\/\//.test(llmUrl)
        ? llmUrl
        : 'https://api.openai.com/v1/chat/completions';


    console.log(
      `[AUDIT ${jobId}] Sending request to LLM: ${endpoint}`
    );

    console.log(
      `[AUDIT ${jobId}] Node version: ${process.version}`
    );


    // ------------------------------------------
    // REQUEST TIMEOUT
    // ------------------------------------------

    const controller = new AbortController();

    const safetyTimeout = setTimeout(() => {
      controller.abort();
    }, 120000);


    // ------------------------------------------
    // SEND REQUEST TO LLM
    // ------------------------------------------

    let response;

    try {
      response = await fetch(endpoint, {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json'
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
          ]
        }),

        signal: controller.signal
      });

    } finally {
      clearTimeout(safetyTimeout);
    }


    // ------------------------------------------
    // READ RAW RESPONSE FIRST
    // ------------------------------------------

    console.log(
      `[AUDIT ${jobId}] LLM HTTP status: ${response.status}`
    );


    const rawText = await response.text();


    console.log(
      `[AUDIT ${jobId}] LLM response preview: ${rawText.slice(0, 500)}`
    );


    // ------------------------------------------
    // HANDLE HTTP ERRORS
    // ------------------------------------------

    if (!response.ok) {
      throw new Error(
        `LLM request failed with HTTP ${response.status}: ` +
        rawText.slice(0, 1000)
      );
    }


    // ------------------------------------------
    // PARSE JSON
    // ------------------------------------------

    let json;

    try {
      json = JSON.parse(rawText);

    } catch (parseError) {
      console.error(
        `[AUDIT ${jobId}] Failed to parse LLM response as JSON`
      );

      throw new Error(
        `LLM returned invalid JSON: ${rawText.slice(0, 1000)}`
      );
    }


    // ------------------------------------------
    // HANDLE API ERRORS
    // ------------------------------------------

    if (json.error) {
      throw new Error(
        json.error.message ||
        JSON.stringify(json.error)
      );
    }


    // ------------------------------------------
    // EXTRACT LLM RESPONSE
    // ------------------------------------------

    const text =
      json?.choices?.[0]?.message?.content ||
      json?.choices?.[0]?.text ||
      json?.output_text ||
      '';


    if (!text || !String(text).trim()) {
      console.error(
        `[AUDIT ${jobId}] LLM returned empty response:`,
        JSON.stringify(json).slice(0, 5000)
      );

      throw new Error('LLM returned an empty audit response');
    }


    // ------------------------------------------
    // SAVE SUCCESSFUL RESULT
    // ------------------------------------------

    job.result = String(text).trim();

    job.truncated = truncated;

    job.finishedAt = Date.now();

    job.status = 'completed';


    console.log(
      `[AUDIT ${jobId}] Audit result stored: ${job.result.length} characters`
    );

    console.log(
      `[AUDIT ${jobId}] Completed in ${job.finishedAt - job.startedAt}ms`
    );


  } catch (err) {

    // ------------------------------------------
    // HANDLE ERRORS
    // ------------------------------------------

    job.status = 'failed';

    job.finishedAt = Date.now();


    if (err?.name === 'AbortError') {
      job.error =
        'The LLM request timed out after 2 minutes.';
    } else {
      job.error = String(
        err?.cause?.message ||
        err?.message ||
        err
      );
    }


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
          : null,

        stack: err?.stack
      }
    );
  }
}


// ------------------------------------------
// API HANDLER
// ------------------------------------------

module.exports = async function handler(req, res) {

  // ------------------------------------------
  // CORS
  // ------------------------------------------

  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

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


  // ==========================================
  // POST - START AUDIT
  // ==========================================

  if (req.method === 'POST') {

    const {
      source,
      systemPrompt,
      model,
      contractName,
      address,
      llmUrl
    } = req.body || {};


    // ------------------------------------------
    // VALIDATE SOURCE
    // ------------------------------------------

    if (!source) {
      return res.status(400).json({
        error: 'source is required'
      });
    }


    // ------------------------------------------
    // VALIDATE SYSTEM PROMPT
    // ------------------------------------------

    if (!systemPrompt) {
      return res.status(400).json({
        error: 'systemPrompt is required'
      });
    }


    // ------------------------------------------
    // GET API KEY
    // ------------------------------------------

    const apiKey =
      req.headers['x-openai-key'] ||
      process.env.OPENAI_API_KEY;


    if (!apiKey) {
      return res.status(500).json({
        error:
          'No API key provided. Use x-openai-key header or OPENAI_API_KEY environment variable.'
      });
    }


    // ------------------------------------------
    // CREATE JOB
    // ------------------------------------------

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


    console.log(
      `[AUDIT ${jobId}] Job created`
    );


    // ------------------------------------------
    // RETURN JOB ID IMMEDIATELY
    // ------------------------------------------

    res.status(202).json({
      jobId,
      status: 'queued'
    });


    // ------------------------------------------
    // RUN AUDIT IN BACKGROUND
    // ------------------------------------------

    runAudit(jobId, {
      source,
      systemPrompt,
      model,
      contractName,
      address,
      llmUrl,
      apiKey
    }).catch((err) => {
      console.error(
        `[AUDIT ${jobId}] Unexpected background error:`,
        err
      );
    });


    return;
  }


  // ==========================================
  // GET - CHECK AUDIT STATUS
  // ==========================================

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

      result:
        job.status === 'completed'
          ? job.result
          : null,

      truncated: job.truncated,

      error:
        job.status === 'failed'
          ? job.error
          : null,

      createdAt: job.createdAt,

      startedAt: job.startedAt,

      finishedAt: job.finishedAt
    });
  }


  // ==========================================
  // METHOD NOT ALLOWED
  // ==========================================

  return res.status(405).json({
    error: 'GET or POST only'
  });
};
             
