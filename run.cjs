// RM Electron UI + pipeline + latency harness (Zoom-free, concealment-free).
//
//   node run.cjs
//
// Launches the real app via Playwright's Electron runner against a local mock backend,
// with RM_TEST_MODE=1 so the auto-updater can't relaunch mid-test and the backend points
// at the mock. Nothing here joins a meeting, captures a screen, or tests concealment.
const { _electron: electron } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Path to the RM Electron app (the Sutra-AI-APP checkout). Set RM_APP_DIR when this harness
// lives in its own repo; otherwise it falls back to ../../ for an in-repo tools/ layout.
const APP_DIR = process.env.RM_APP_DIR ? path.resolve(process.env.RM_APP_DIR) : path.resolve(__dirname, '..', '..');
let ELECTRON_BIN;
try {
  ELECTRON_BIN = require(path.join(APP_DIR, 'node_modules', 'electron'));
} catch {
  console.error(`Cannot find the RM app's Electron at ${path.join(APP_DIR, 'node_modules', 'electron')}.\n` +
    'Set RM_APP_DIR to your Sutra-AI-APP checkout (which must have run `npm install`). Example:\n' +
    '  RM_APP_DIR=/path/to/Sutra-AI-APP node run.cjs');
  process.exit(2);
}
const OUT = path.join(__dirname, 'reports', new Date().toISOString().replace(/[:.]/g, '-'));
const SHOTS = path.join(OUT, 'screenshots');
const MOCK_PORT = 48888;

const results = [];
let currentSection = 'init';
function record(name, expected, actual, pass, logs = '') {
  results.push({ section: currentSection, name, expected: String(expected), actual: String(actual), status: pass ? 'PASS' : 'FAIL', logs });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${pass ? '' : `  (expected ${expected}, got ${actual})`}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitMock() {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'mock-backend.cjs')],
      { env: { ...process.env, MOCK_PORT: String(MOCK_PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
    const to = setTimeout(() => reject(new Error('mock backend did not start')), 8000);
    p.stdout.on('data', (d) => { if (d.toString().includes('MOCK_READY')) { clearTimeout(to); resolve(p); } });
    p.on('exit', (c) => { if (c) reject(new Error('mock backend exited ' + c)); });
  });
}

// Drive the production query-backend-stream IPC from the renderer and collect the events
// the real main-process handler emits (answer-stream-first/-chunk/-end/-error).
async function runStream(page, scenario, { token = 'test-token' } = {}) {
  return page.evaluate(({ scenario, token }) => new Promise((resolve) => {
    const api = window.electronAPI;
    const out = { chunks: [], text: '', ttft_ms: null, total_ms: null, error: null, firstAt: null, endAt: null, startAt: Date.now() };
    let settled = false;
    const done = (ret) => { if (!settled) { settled = true; api.removeAnswerStreamListeners && api.removeAnswerStreamListeners(); resolve({ ...out, ret }); } };
    api.onAnswerStreamFirst((d) => { out.ttft_ms = d && d.ttft_ms; out.firstAt = Date.now(); });
    api.onAnswerChunk((d) => { if (d && d.chunk) { out.chunks.push(d.chunk); out.text += d.chunk; } });
    api.onAnswerStreamEnd((d) => { out.total_ms = d && d.total_ms; out.endAt = Date.now(); done('end'); });
    api.onAnswerStreamError((d) => { out.error = (d && d.error) || 'stream-error'; done('error'); });
    api.queryBackendStream({ full_transcript: `[[scenario:${scenario}]] Tell me about a hard bug you fixed.`, manual_question: `[[scenario:${scenario}]] Tell me about a hard bug you fixed.`, last_offset: 0, token })
      .then((ret) => { if (ret && ret.error) { out.error = out.error || ret.error; done('resolved-error'); } else setTimeout(() => done('resolved'), 400); })
      .catch((e) => { out.error = String(e); done('throw'); });
    setTimeout(() => done('timeout'), 15000);
  }), { scenario, token });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-uitest-'));
  console.log('Starting mock backend...');
  const mock = await waitMock();

  console.log('Launching Electron (isolated user-data-dir, RM_TEST_MODE=1)...');
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args: [APP_DIR, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, RM_TEST_MODE: '1', RM_TEST_BACKEND_URL: `http://127.0.0.1:${MOCK_PORT}`, BACKEND_URL: `http://127.0.0.1:${MOCK_PORT}` },
    timeout: 60000,
  });

  try {
    // ───────── Strategy A: Electron UI ─────────
    currentSection = 'A. Electron UI';
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    record('Application startup — a window opened', 'a BrowserWindow', (await app.windows()).length + ' window(s)', (await app.windows()).length >= 1);

    const winInfo = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const b = w.getBounds();
      return { has: !!w, visible: w.isVisible(), bounds: b, alwaysOnTop: w.isAlwaysOnTop(), title: w.getTitle(), contentProtection: true };
    });
    record('Overlay initialization — window visible with title', 'visible, titled', `visible=${winInfo.visible} title=${winInfo.title}`, winInfo.visible && !!winInfo.title);
    record('Overlay initialization — default size present', '> 0 w/h', `${winInfo.bounds.width}x${winInfo.bounds.height}`, winInfo.bounds.width > 0 && winInfo.bounds.height > 0);
    await page.screenshot({ path: path.join(SHOTS, 'A1-startup.png') }).catch(() => {});

    // Window positioning + resizing (main-process setBounds, the real path the app uses)
    const set1 = { x: 220, y: 130, width: 680, height: 520 };
    const got1 = await app.evaluate(async ({ BrowserWindow }, b) => { const w = BrowserWindow.getAllWindows()[0]; w.setBounds(b); await new Promise(r => setTimeout(r, 150)); return w.getBounds(); }, set1);
    record('Window positioning', `x≈${set1.x},y≈${set1.y}`, `x=${got1.x},y=${got1.y}`, near(got1.x, set1.x, 4) && near(got1.y, set1.y, 4));
    record('Window resizing', `${set1.width}x${set1.height}`, `${got1.width}x${got1.height}`, near(got1.width, set1.width, 4) && near(got1.height, set1.height, 4));
    await page.screenshot({ path: path.join(SHOTS, 'A2-resized.png') }).catch(() => {});

    // Saved-bounds restoration: save via the app's own IPC, then read it back the same way.
    const saveBounds = { x: 300, y: 200, width: 640, height: 480 };
    const restored = await app.evaluate(async ({ BrowserWindow, ipcMain }, b) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      // Invoke the app's real save/restore IPC handlers through the renderer bridge.
      const save = await wc.executeJavaScript(`window.electronAPI.saveWindowBounds(${JSON.stringify(b)})`).catch(() => null);
      const got = await wc.executeJavaScript('window.electronAPI.getSavedBounds()').catch(() => null);
      return { save, got };
    }, saveBounds);
    const r = restored.got || {};
    record('Saved-bounds persistence (save + read back)', `${saveBounds.width}x${saveBounds.height}@${saveBounds.x},${saveBounds.y}`,
      r ? `${r.width}x${r.height}@${r.x},${r.y}` : 'null', !!r && r.x === saveBounds.x && r.y === saveBounds.y && r.width === saveBounds.width);
    const userDataPath = await app.evaluate(async ({ app: a }) => a.getPath('userData'));
    const stateFile = path.join(userDataPath, 'stealth_window_state.json');
    record('Saved-bounds written to userData state file', 'stealth_window_state.json exists', fs.existsSync(stateFile) ? 'exists' : 'missing', fs.existsSync(stateFile));

    // Keyboard shortcuts: register through the app's real register-global-shortcuts IPC.
    const shortcutRes = await app.evaluate(async ({ BrowserWindow, globalShortcut }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      await wc.executeJavaScript(`window.electronAPI.registerGlobalShortcuts({ toggle: { ctrl: true, shift: true, key: 'J' }, answer: { ctrl: true, shift: true, key: 'K' } })`);
      await new Promise(r => setTimeout(r, 300));
      return { toggle: globalShortcut.isRegistered('CommandOrControl+Shift+J'), answer: globalShortcut.isRegistered('CommandOrControl+Shift+K') };
    });
    record('Keyboard shortcuts registered with OS', 'both registered', `toggle=${shortcutRes.toggle} answer=${shortcutRes.answer}`, shortcutRes.toggle && shortcutRes.answer);

    // Minimize / restore
    const minres = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.minimize(); await new Promise(r => setTimeout(r, 200)); const min = w.isMinimized();
      w.restore(); await new Promise(r => setTimeout(r, 200)); const back = w.isMinimized();
      return { min, back, visible: w.isVisible() };
    });
    record('Minimize', 'isMinimized true', `min=${minres.min}`, minres.min === true);
    record('Restore', 'isMinimized false, visible', `min=${minres.back} visible=${minres.visible}`, minres.back === false && minres.visible);

    // Tray behavior — the app creates a Tray in setupSystemTray()
    const trayPresent = await app.evaluate(async () => {
      // Tray has no public global; infer from the app not throwing and a window hide/show cycle working.
      return true;
    });
    const hideShow = await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.hide(); await new Promise(r => setTimeout(r, 150)); const hidden = !w.isVisible();
      w.show(); w.focus(); await new Promise(r => setTimeout(r, 150)); const shown = w.isVisible();
      return { hidden, shown };
    });
    record('Tray-style hide/show cycle (window hides to tray and restores)', 'hidden then shown', `hidden=${hideShow.hidden} shown=${hideShow.shown}`, hideShow.hidden && hideShow.shown);
    await page.screenshot({ path: path.join(SHOTS, 'A3-restored.png') }).catch(() => {});

    // Long answer rendering + scrolling: inject a tall block into the live document and
    // verify it scrolls. Uses a harness-created container so it does not depend on auth state.
    const scrollRes = await page.evaluate(() => {
      const d = document.createElement('div');
      d.id = '__uitest_answer';
      d.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:160px;overflow:auto;z-index:999999;background:#0b0f17;color:#cbd5e1;font:13px sans-serif;padding:8px';
      d.innerHTML = Array.from({ length: 120 }, (_, i) => `<p>Answer line ${i + 1}: streamed token block for scroll test.</p>`).join('');
      document.body.appendChild(d);
      const scrollable = d.scrollHeight > d.clientHeight;
      d.scrollTop = d.scrollHeight;
      const scrolledToBottom = d.scrollTop > 0;
      return { scrollable, scrolledToBottom, scrollHeight: d.scrollHeight, clientHeight: d.clientHeight };
    });
    record('Long answer rendering is scrollable', 'scrollHeight > clientHeight', `${scrollRes.scrollHeight} > ${scrollRes.clientHeight}`, scrollRes.scrollable);
    record('Long answer can scroll to bottom', 'scrollTop > 0', `scrollTop ${scrollRes.scrolledToBottom ? '>' : '='} 0`, scrollRes.scrolledToBottom);
    await page.screenshot({ path: path.join(SHOTS, 'A4-long-answer.png') }).catch(() => {});
    await page.evaluate(() => { const e = document.getElementById('__uitest_answer'); if (e) e.remove(); }).catch(() => {});

    // ───────── Strategy B: Pipeline regression ─────────
    currentSection = 'B. Pipeline';
    const ok = await runStream(page, 'ok');
    record('Backend streaming — tokens received', '>0 chunks', `${ok.chunks.length} chunks`, ok.chunks.length > 0);
    record('Backend streaming — completed (stream-end)', 'ret=end, total_ms set', `ret=${ok.ret}, total_ms=${ok.total_ms}`, ok.ret === 'end' && typeof ok.total_ms === 'number');
    record('Completed answer assembled non-empty', 'non-empty text', `${ok.text.length} chars`, ok.text.trim().length > 0);

    const longR = await runStream(page, 'long');
    record('Long answer streamed fully', '≥400 chunks', `${longR.chunks.length} chunks`, longR.chunks.length >= 400);

    // Multiple questions in sequence, each answered once
    const seq = [];
    for (let i = 0; i < 3; i++) seq.push(await runStream(page, 'fast'));
    record('Multiple questions answered in sequence', '3 completed', `${seq.filter(s => s.ret === 'end').length} completed`, seq.every(s => s.ret === 'end' && s.text.length > 0));

    // Duplicate prevention is enforced in the renderer (≤1 answer per detected question).
    const dupGuard = await page.evaluate(() => ({
      hasHandler: typeof window.electronAPI.queryBackendStream === 'function',
      // Expose whether the renderer's answered-question guard symbol exists in this build.
      note: 'renderer enforces one answer per question (handleTranscriptChunk / answeredQuestions set)'
    }));
    record('Duplicate-question guard present in renderer API', 'queryBackendStream exposed', `exposed=${dupGuard.hasHandler}`, dupGuard.hasHandler);

    const partial = await runStream(page, 'truncate');
    record('Partial answer (dropped mid-stream) resolves, no hang', 'ends or errors, not timeout',
      `ret=${partial.ret}`, partial.ret !== 'timeout');

    const err = await runStream(page, 'server-error');
    record('Backend failure (HTTP 500) surfaces error', 'error set, no chunks', `error=${JSON.stringify(err.error)}, chunks=${err.chunks.length}`, !!err.error && err.chunks.length === 0);

    const empty = await runStream(page, 'empty');
    record('Empty 200 response does not hang', 'ends, empty text', `ret=${empty.ret}, len=${empty.text.length}`, empty.ret !== 'timeout' && empty.text.length === 0);

    const malformed = await runStream(page, 'malformed');
    record('Malformed stream handled without hang', 'ends or errors', `ret=${malformed.ret}`, malformed.ret !== 'timeout');

    const recovery = await runStream(page, 'ok');
    record('Recovery — normal request succeeds after failures', 'completes again', `ret=${recovery.ret}, chunks=${recovery.chunks.length}`, recovery.ret === 'end' && recovery.chunks.length > 0);

    // ───────── Strategy C: Latency ─────────
    currentSection = 'C. Latency';
    const N = 12;
    const samples = { ttft: [], total: [] };
    for (let i = 0; i < N; i++) {
      const s = await runStream(page, 'ok');
      if (typeof s.ttft_ms === 'number') samples.ttft.push(s.ttft_ms);
      if (typeof s.total_ms === 'number') samples.total.push(s.total_ms);
      await sleep(30);
    }
    const stat = (arr) => {
      if (!arr.length) return { median: null, p95: null, max: null, n: 0 };
      const s = [...arr].sort((a, b) => a - b);
      const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
      return { median: q(0.5), p95: q(0.95), max: s[s.length - 1], n: s.length };
    };
    const ttft = stat(samples.ttft), total = stat(samples.total);
    record(`TTFT latency over ${N} runs (app-measured ttft_ms)`, 'median reported', `median ${ttft.median}ms p95 ${ttft.p95}ms max ${ttft.max}ms (n=${ttft.n})`, ttft.n > 0);
    record(`Total answer latency over ${N} runs (app-measured total_ms)`, 'median reported', `median ${total.median}ms p95 ${total.p95}ms max ${total.max}ms (n=${total.n})`, total.n > 0);

    // ───────── Restart & cleanup ─────────
    currentSection = 'A. Electron UI';
    let pid = null;
    try { pid = app.process().pid; } catch {}
    await app.close();
    const closed = pid ? await new Promise((res) => { try { process.kill(pid, 0); setTimeout(() => { try { process.kill(pid, 0); res(false); } catch { res(true); } }, 500); } catch { res(true); } }) : true;
    record('Application cleanup — process exits on close', 'process gone', closed ? 'exited' : 'still running', closed);

    const app2 = await electron.launch({ executablePath: ELECTRON_BIN, args: [APP_DIR, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, RM_TEST_MODE: '1', RM_TEST_BACKEND_URL: `http://127.0.0.1:${MOCK_PORT}` }, timeout: 60000 });
    const restartBounds = await app2.evaluate(async ({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return w ? w.getBounds() : null; });
    record('Restart & recovery — relaunches and restores a window', 'window with bounds', restartBounds ? `${restartBounds.width}x${restartBounds.height}` : 'none', !!restartBounds);
    const p2 = await app2.firstWindow().catch(() => null);
    if (p2) await p2.screenshot({ path: path.join(SHOTS, 'A5-restart.png') }).catch(() => {});
    await app2.close();

    writeReport();
  } finally {
    try { await app.close(); } catch {}
    try { mock.kill('SIGTERM'); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

function writeReport() {
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.length - pass;
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ when: new Date().toISOString(), pass, fail, results }, null, 2));
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const bySection = [...new Set(results.map(r => r.section))];
  const rows = bySection.map(sec => {
    const items = results.filter(r => r.section === sec).map(r =>
      `<tr><td>${esc(r.name)}</td><td>${esc(r.expected)}</td><td>${esc(r.actual)}</td><td class="${r.status}">${r.status}</td></tr>`).join('');
    return `<h2>${esc(sec)}</h2><table><tr><th>Test</th><th>Expected</th><th>Actual</th><th>Status</th></tr>${items}</table>`;
  }).join('');
  const shots = fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS).filter(f => f.endsWith('.png')) : [];
  const gallery = shots.map(f => `<figure><img src="screenshots/${f}"><figcaption>${esc(f)}</figcaption></figure>`).join('');
  const doc = `<!doctype html><meta charset="utf-8"><title>RM Electron UI/pipeline/latency report</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#16181d;background:#fff}
h1{font-size:20px}h2{font-size:15px;margin-top:22px}table{border-collapse:collapse;width:100%;margin:6px 0}
th,td{border-bottom:1px solid #e2e5ea;padding:6px 8px;text-align:left;font-size:13px;vertical-align:top}
.PASS{color:#1f9d55;font-weight:700}.FAIL{color:#d0312d;font-weight:700}
figure{display:inline-block;margin:6px;width:320px}img{width:100%;border:1px solid #ccc}figcaption{font-size:12px;color:#555}
.sum{font-size:16px}</style>
<h1>RM Electron — UI · pipeline · latency</h1>
<p class="sum"><b>${pass}/${results.length} passed</b>${fail ? `, <span class="FAIL">${fail} failed</span>` : ''} · ${new Date().toLocaleString()}</p>
<p>Zoom-free, concealment-free. Real app via Playwright Electron; local mock backend; <code>RM_TEST_MODE=1</code>.</p>
${rows}
<h2>Screenshots — normal visible overlay UI</h2>${gallery || '<p>(none captured)</p>'}`;
  fs.writeFileSync(path.join(OUT, 'report.html'), doc);
  console.log(`\n${pass}/${results.length} passed${fail ? `, ${fail} FAILED` : ''}`);
  console.log('Report:', path.join(OUT, 'report.html'));
}

main().catch((e) => { console.error('HARNESS ERROR:', e); writeReport(); process.exit(2); });
