// POST /api/audit
// Body: { source, systemPrompt, model, contractName, address, llmUrl }
// Sends the contract source to a chat-completions-style endpoint (OpenAI by default,
// or any OpenAI-compatible provider via llmUrl) and returns the audit text.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-openai-key');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const { source, systemPrompt, model, contractName, address, llmUrl } = req.body || {};

  if (!source) {
    return res.status(400).json({ error: 'source is required' });
  }
  if (!systemPrompt) {
    return res.status(400).json({ error: 'systemPrompt is required' });
  }

  const apiKey = req.headers['x-openai-key'] || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'No OpenAI API key provided (header x-openai-key or OPENAI_API_KEY env var)' });
  }

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

  const endpoint = (llmUrl && /^https?:\/\//.test(llmUrl))
    ? llmUrl
    : 'https://api.openai.com/v1/chat/completions';

  try {
    const r = await fetch(endpoint, {
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
