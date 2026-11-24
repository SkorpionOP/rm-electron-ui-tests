// Local mock of the RM backend:
// 1. /api/answer/stream (for Strategy B/C LLM streaming simulations)
// 2. /api/test-results (ingests automated pipeline test results in JSON format)
const http = require('http');
const fs = require('fs');
const path = require('path');

const WORD = (process.env.MOCK_ANSWER
  || 'Use the STAR method. Situation: scope the problem. Task: state your goal. '
  + 'Action: describe the concrete steps you took. Result: quantify the outcome.').split(' ');

function stream(res, { ttftMs = 40, gapMs = 8, words = WORD, truncate = false }) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Transfer-Encoding': 'chunked' });
  let i = 0;
  const sendOne = () => {
    if (i >= words.length || (truncate && i >= Math.ceil(words.length / 2))) {
      if (truncate) return res.destroy();      // simulate a dropped connection mid-answer
      return res.end();
    }
    res.write(words[i] + (i < words.length - 1 ? ' ' : ''));
    i += 1;
    setTimeout(sendOne, gapMs);
  };
  setTimeout(sendOne, ttftMs);                 // time-to-first-token
}

let latestTestResults = null;

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  // 1. Ingest test results in JSON format
  if ((req.method === 'POST') && (req.url.startsWith('/api/test-results') || req.url.startsWith('/api/pipeline/results'))) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        latestTestResults = {
          ...payload,
          _serverReceivedAt: new Date().toISOString()
        };

        const reportsDir = path.join(__dirname, 'reports');
        if (!fs.existsSync(reportsDir)) {
          fs.mkdirSync(reportsDir, { recursive: true });
        }
        fs.writeFileSync(
          path.join(reportsDir, 'backend-received-latest.json'),
          JSON.stringify(latestTestResults, null, 2)
        );

        const summary = payload.summary || {};
        console.log(`[BACKEND-API] ✅ Received test results: ${summary.passCount || 0} passed, ${summary.failCount || 0} failed across ${summary.totalApps || 1} apps.`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'success',
          jobId: payload.jobId || 'unknown',
          receivedAt: latestTestResults._serverReceivedAt,
          summary: {
            passCount: summary.passCount || 0,
            failCount: summary.failCount || 0,
            status: summary.status || 'UNKNOWN'
          }
        }));
      } catch (err) {
        console.error('[BACKEND-API] Invalid JSON received:', err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Invalid JSON payload' }));
      }
    });
    return;
  }

  // 2. Query latest test results
  if (req.method === 'GET' && (req.url.startsWith('/api/test-results') || req.url.startsWith('/api/pipeline/results'))) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(latestTestResults || { message: 'No test results received yet' }));
    return;
  }

  // 3. /api/answer/stream (for existing pipeline streaming tests)
  if (req.method === 'POST' && req.url.startsWith('/api/answer/stream')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let scenario = 'ok';
      const m = body.match(/\[\[scenario:([a-z-]+)\]\]/);
      if (m) scenario = m[1];
      body = '';
      switch (scenario) {
        case 'ok': return stream(res, {});
        case 'fast': return stream(res, { ttftMs: 15, gapMs: 2 });
        case 'slow': return stream(res, { ttftMs: 300, gapMs: 25 });
        case 'long': return stream(res, { ttftMs: 40, gapMs: 1, words: Array.from({ length: 400 }, (_, n) => `line${n}`) });
        case 'truncate': return stream(res, { truncate: true });
        case 'server-error':
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ detail: 'Simulated backend failure' }));
        case 'malformed':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end('{ this is : not valid json ][');
        case 'empty':
          res.writeHead(200).end('');
          return;
        default: return stream(res, {});
      }
    });
    return;
  }

  res.writeHead(404).end('not found');
});

const port = Number(process.env.MOCK_PORT || 48888);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`MOCK_READY ${port}\n`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
