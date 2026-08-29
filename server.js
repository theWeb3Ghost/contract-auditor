const express = require('express');
const path = require('path');

const etherscanHandler = require('./api/etherscan');
const auditHandler = require('./api/audit');

const app = express();

// Contract source can be sizeable — allow a larger body than Express's 100kb default.
app.use(express.json({ limit: '2mb' }));

// CORS handled once, globally, ahead of the route handlers below.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-etherscan-key, x-openai-key');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.get('/api/etherscan', etherscanHandler);
app.get('/api/audit/:jobId', auditHandler);
app.post('/api/audit', auditHandler);

// Serves index.html (and anything else placed alongside it) as static files.
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Contract Auditor listening on port ${PORT}`);
});

// Disable Node's own request timeout so a slow LLM call isn't killed at the app layer.
// (Render's own infrastructure may still impose limits outside this app's control.)
server.requestTimeout = 0;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
