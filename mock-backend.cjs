// Local mock of the RM backend's /api/answer/stream, for Strategy B/C.
// Scenario is chosen per-request by a header so one server covers every case.
// It never calls any real model and logs nothing from the request body.
const http = require('http');

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

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/api/answer/stream')) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    // Scenario comes from a test marker the harness puts in the synthetic question/transcript
    // (e.g. "[[scenario:slow]]"). We extract only that marker and discard the rest of the body.
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
        res.writeHead(200).end('');            // 200 but zero tokens
        return;
      default: return stream(res, {});
    }
  });
});

const port = Number(process.env.MOCK_PORT || 48888);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`MOCK_READY ${port}\n`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
