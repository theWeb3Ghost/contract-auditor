// POST /api/audit
// Body: { source, systemPrompt, model, contractName, address }
// Sends the contract source to OpenAI's chat completions endpoint and returns the audit text.
// This runs server-side specifically so the OpenAI key never reaches the browser, and so
// we sidestep the chat completions endpoint's inconsistent CORS behavior from browsers.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const { source, systemPrompt, model, contractName, address } = req.body || {};

  if (!source) {
    return res.status(400).json({ error: 'source is required' });
  }
  if (!systemPrompt) {
    return res.status(400).json({ error: 'systemPrompt is required' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server' });
  }

  // Rough guard against blowing the model's context window on huge contracts.
  const MAX_CHARS = 60000;
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
    (truncated ? '\n\n[NOTE: source was truncated to fit context length]' : '');

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    const j = await r.json();

    if (j.error) {
      return res.status(502).json({ error: j.error.message || 'OpenAI API error' });
    }

    const text = j.choices && j.choices[0] && j.choices[0].message
      ? j.choices[0].message.content
      : '';

    return res.json({ result: text, truncated });
  } catch (err) {
    return res.status(500).json({ error: String(err && err.message ? err.message : err) });
  }
}
