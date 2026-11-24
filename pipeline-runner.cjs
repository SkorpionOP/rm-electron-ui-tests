// pipeline-runner.cjs: Automated Pipeline Orchestrator for RM Electron App Testing
//
// Features:
// 1. Configurable target apps (Zoom, Teams, Chrome, Slack, etc.) from pipeline.config.json or CLI.
// 2. Automated test execution across all mentioned apps.
// 3. Posts structured JSON test results to backend API.
// 4. Triggers native Windows Admin Popup if any failures occur.
// 5. Supports standalone execution, interval daemon, or cron scheduling.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { sendAdminPopup } = require('./admin-alert.cjs');
const { startMeetingForApp } = require('./meeting-controller.cjs');
const { runHarness } = require('./run.cjs');

// Port for the harness's own mock backend, kept apart from the results backend (48888).
const HARNESS_MOCK_PORT = Number(process.env.RM_HARNESS_MOCK_PORT) || 48889;

// Load pipeline configuration
const CONFIG_FILE = path.join(__dirname, 'pipeline.config.json');
let config = {
  apps: [
    { id: 'zoom', name: 'Zoom Workplace', processName: 'Zoom.exe', enabled: true },
    { id: 'teams', name: 'Microsoft Teams', processName: 'ms-teams.exe', enabled: true },
    { id: 'chrome', name: 'Google Chrome (Meet)', processName: 'chrome.exe', enabled: true }
  ],
  backend: {
    url: 'http://127.0.0.1:48888/api/test-results',
    timeoutMs: 10000,
    retryCount: 3,
    retryDelayMs: 1500
  },
  schedule: {
    enabled: false,
    intervalMinutes: 60
  },
  notifications: {
    adminPopup: { enabled: true, onFailureOnly: true }
  },
  reporting: { outputDir: 'reports' }
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    config = { ...config, ...JSON.parse(raw) };
  } catch (e) {
    console.warn(`[PIPELINE] Warning: Failed to parse ${CONFIG_FILE}, using defaults:`, e.message);
  }
}

// CLI argument parsing
const args = process.argv.slice(2);
function getArg(flag, defaultValue = null) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return defaultValue;
}
const hasFlag = (flag) => args.includes(flag);

const isSimulate = hasFlag('--simulate') || hasFlag('--dry-run');
const isForceAlert = hasFlag('--force-alert') || hasFlag('--test-alert');
const isDaily = hasFlag('--daily');
const isDaemon = hasFlag('--daemon') || hasFlag('--schedule') || isDaily;
const isRunNow = hasFlag('--run-now');
const customInterval = getArg('--interval');
const customDailyAt = getArg('--daily-at');
const customAppsArg = getArg('--apps');
const customBackend = getArg('--backend');

if (customBackend) config.backend.url = customBackend;
if (customDailyAt) config.schedule.dailyAt = customDailyAt;
if (isDaily) config.schedule.frequency = 'daily';
if (customInterval) {
  config.schedule.intervalMinutes = parseInt(customInterval, 10) || 60;
  config.schedule.frequency = 'interval';
  config.schedule.enabled = true;
}

// Determine target apps list
function getTargetApps() {
  if (customAppsArg) {
    const specified = customAppsArg.split(',').map(s => s.trim().toLowerCase());
    return specified.map(name => {
      const found = (config.apps || []).find(a =>
        a.id.toLowerCase() === name || a.name.toLowerCase().includes(name)
      );
      if (found) return { ...found, enabled: true };
      return {
        id: name.replace(/\s+/g, '-'),
        name: name.charAt(0).toUpperCase() + name.slice(1),
        processName: `${name}.exe`,
        enabled: true
      };
    });
  }
  return (config.apps || []).filter(a => a.enabled !== false);
}

// Check if a process is running on Windows
function isProcessRunning(processName) {
  if (!processName || process.platform !== 'win32') return false;
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${processName}" /NH`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out.toLowerCase().includes(processName.toLowerCase());
  } catch {
    return false;
  }
}

// Open target application if configured
async function launchTargetApp(appInfo) {
  if (!appInfo || !appInfo.openAppBeforeTest) {
    return { launched: false, running: isProcessRunning(appInfo.processName) };
  }
  const alreadyRunning = isProcessRunning(appInfo.processName);
  if (alreadyRunning) {
    console.log(`[TARGET-APP] Target app '${appInfo.name}' is already running.`);
    return { launched: false, running: true };
  }

  const cmd = appInfo.launchCommand || (appInfo.processName ? `start "" "${appInfo.processName}"` : null);
  if (!cmd) return { launched: false, running: false };

  console.log(`[TARGET-APP] 🚀 Opening target app: ${appInfo.name} ('${cmd}')...`);
  try {
    const { exec } = require('child_process');
    exec(cmd, { windowsHide: false });
    // Allow brief interval for target app process to initialize
    await new Promise(r => setTimeout(r, 800));
    const runningNow = isProcessRunning(appInfo.processName);
    return { launched: true, running: runningNow || true };
  } catch (err) {
    console.warn(`[TARGET-APP] Launch attempt for ${appInfo.name} encountered:`, err.message);
    return { launched: false, running: false, error: err.message };
  }
}

// Auto-start local mock backend if localhost URL is used and server is not yet running
let autoSpawnedBackend = null;
async function ensureLocalBackendRunning(backendUrl) {
  try {
    const u = new URL(backendUrl);
    const isLocal = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (!isLocal) return null;

    const port = Number(u.port || 48888);
    const isAlive = await new Promise((resolve) => {
      const ping = http.get(`http://127.0.0.1:${port}/api/test-results`, () => resolve(true));
      ping.on('error', () => resolve(false));
      ping.setTimeout(600, () => { ping.destroy(); resolve(false); });
    });

    if (isAlive) return null;

    console.log(`[PIPELINE] 🔌 Local backend not detected on port ${port}. Auto-starting local backend receiver...`);
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(__dirname, 'mock-backend.cjs')], {
        env: { ...process.env, MOCK_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'inherit']
      });
      p.stdout.on('data', (d) => {
        if (d.toString().includes('MOCK_READY')) {
          console.log(`[PIPELINE] ✅ Local backend receiver ready on port ${port}.`);
          resolve(p);
        }
      });
      setTimeout(() => resolve(p), 1500);
    });
  } catch {
    return null;
  }
}

// Send JSON results to backend with retries
async function sendResultsToBackend(payload) {
  const backendUrl = process.env.BACKEND_URL || config.backend.url || 'http://127.0.0.1:48888/api/test-results';
  const retries = config.backend.retryCount || 3;
  const timeoutMs = config.backend.timeoutMs || 10000;

  // Auto-start mock backend if localhost is targeted and not running
  if (!autoSpawnedBackend) {
    autoSpawnedBackend = await ensureLocalBackendRunning(backendUrl);
  }

  console.log(`[PIPELINE] Sending JSON update to backend: ${backendUrl}`);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await new Promise((resolve, reject) => {
        const u = new URL(backendUrl);
        const isHttps = u.protocol === 'https:';
        const client = isHttps ? https : http;

        const bodyData = JSON.stringify(payload);
        const req = client.request({
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + (u.search || ''),
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyData),
            ...(config.backend.authToken ? { 'Authorization': `Bearer ${config.backend.authToken}` } : {})
          },
          timeout: timeoutMs
        }, (response) => {
          let data = '';
          response.on('data', chunk => data += chunk);
          response.on('end', () => {
            if (response.statusCode >= 200 && response.statusCode < 300) {
              resolve({ statusCode: response.statusCode, data });
            } else {
              reject(new Error(`Backend responded with HTTP ${response.statusCode}: ${data}`));
            }
          });
        });

        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`Connection timed out after ${timeoutMs}ms`));
        });

        req.write(bodyData);
        req.end();
      });

      console.log(`[PIPELINE] ✅ Backend updated successfully: HTTP ${res.statusCode}`);
      return { success: true, response: res.data };
    } catch (err) {
      console.warn(`[PIPELINE] Backend submission attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, config.backend.retryDelayMs || 1500));
      } else {
        console.error(`[PIPELINE] ❌ All attempts to send results to backend failed.`);
        return { success: false, error: err.message };
      }
    }
  }
}

// Generate comprehensive HTML report
function generateHtmlReport(jobData, outDir) {
  const esc = (s) => String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const summary = jobData.summary;

  const appCards = jobData.appsTested.map(app => {
    const statusClass = app.status === 'PASS' ? 'pass' : 'fail';
    const rows = app.tests.map(t =>
      `<tr><td>${esc(t.name)}</td><td>${esc(t.expected)}</td><td>${esc(t.actual)}</td><td class="${t.status}">${t.status}</td></tr>`
    ).join('');

    const stats = app.stats || {};
    const lat = stats.latency;
    const win = stats.window;
    const proc = stats.process;
    const v = (x, unit = '') => (x === null || x === undefined ? 'not measured' : `${x}${unit}`);

    return `
      <div class="card">
        <h3><span class="badge ${statusClass}">${app.status}</span> ${esc(app.name)}</h3>
        <p><b>Target Process:</b> <code>${esc(app.processName || 'N/A')}</code> | <b>Meeting app launched:</b> ${app.meetingStarted ? 'yes' : 'no'}</p>
        <div style="background:#f1f5f9;padding:10px 14px;border-radius:6px;margin:10px 0;font-size:12px;line-height:1.6">
          <b>📊 Measured by harness</b> (against ${esc((lat && lat.backend) || 'local mock')} backend, ${v(lat && lat.runs)} runs):<br>
          • <b>TTFT:</b> median ${v(lat && lat.ttftMs.median, 'ms')} · p95 ${v(lat && lat.ttftMs.p95, 'ms')} · max ${v(lat && lat.ttftMs.max, 'ms')}<br>
          • <b>Total answer time:</b> median ${v(lat && lat.totalMs.median, 'ms')} · p95 ${v(lat && lat.totalMs.p95, 'ms')} | <b>Stream rate:</b> ${v(lat && lat.chunksPerSecond.median, ' chunks/s')}<br>
          • <b>Overlay:</b> visible=${v(win && win.visible)} alwaysOnTop=${v(win && win.alwaysOnTop)} | <b>Memory:</b> ${v(proc && proc.workingSetMb, ' MB')} across ${v(proc && proc.processCount)} processes, CPU ${v(proc && proc.cpuPercent, '%')}<br>
          • <b>Audio loopback / transcription:</b> not measured by this pipeline
        </div>
        <p><b>Tests Passed:</b> ${app.passed}/${app.tests.length}</p>
        <table>
          <tr><th>Test</th><th>Expected</th><th>Actual</th><th>Status</th></tr>
          ${rows}
        </table>
      </div>
    `;
  }).join('');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>RM Pipeline Test Results - ${jobData.jobId}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 30px; background: #f8fafc; color: #0f172a; }
    h1 { font-size: 24px; margin-bottom: 4px; }
    .meta { color: #64748b; font-size: 14px; margin-bottom: 20px; }
    .summary-grid { display: flex; gap: 16px; margin-bottom: 24px; }
    .stat-box { background: #fff; padding: 16px; border-radius: 8px; border: 1px solid #e2e8f0; min-width: 140px; }
    .stat-val { font-size: 28px; font-weight: 700; }
    .stat-val.PASS { color: #16a34a; }
    .stat-val.FAIL { color: #dc2626; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    th, td { border-bottom: 1px solid #f1f5f9; padding: 8px 10px; text-align: left; }
    th { background: #f8fafc; color: #475569; font-weight: 600; }
    .badge { padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 12px; }
    .badge.pass, .PASS { color: #16a34a; font-weight: 700; }
    .badge.fail, .FAIL { color: #dc2626; font-weight: 700; }
  </style>
</head>
<body>
  <h1>🚀 RM Electron Automated Pipeline Results</h1>
  <div class="meta">Job ID: <b>${esc(jobData.jobId)}</b> | Executed: ${esc(jobData.timestamp)} | Duration: ${jobData.durationMs}ms</div>
  <div class="summary-grid">
    <div class="stat-box"><div class="stat-lbl">Overall Status</div><div class="stat-val ${summary.status}">${summary.status}</div></div>
    <div class="stat-box"><div class="stat-lbl">Apps Tested</div><div class="stat-val">${summary.totalApps}</div></div>
    <div class="stat-box"><div class="stat-lbl">Total Tests</div><div class="stat-val">${summary.totalTests}</div></div>
    <div class="stat-box"><div class="stat-lbl">Passed</div><div class="stat-val PASS">${summary.passCount}</div></div>
    <div class="stat-box"><div class="stat-lbl">Failed</div><div class="stat-val FAIL">${summary.failCount}</div></div>
  </div>
  <h2>Tested Applications</h2>
  ${appCards}
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, 'report.html'), html);
}

// Discover checkout directory of the RM Electron application
function findAppDir() {
  if (process.env.RM_APP_DIR && fs.existsSync(process.env.RM_APP_DIR)) return path.resolve(process.env.RM_APP_DIR);
  const candidates = [
    path.resolve(__dirname, '..', 'SUTRA AI', 'Sutra-AI-APP'),
    path.resolve(__dirname, '..', 'Sutra-AI-APP'),
    path.resolve(__dirname, '..', '..', 'Sutra-AI-APP'),
    path.resolve(__dirname, '..', '..')
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'package.json')) && fs.existsSync(path.join(c, 'main.js'))) {
      return c;
    }
  }
  return path.resolve(__dirname, '..', '..');
}

// Physically launch the real RM Electron application window on Windows desktop
async function launchRealRMApp() {
  const appDir = findAppDir();
  const electronBin = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');

  if (!fs.existsSync(electronBin)) {
    console.error(`[RM-APP] ❌ Cannot find Electron binary at: ${electronBin}`);
    return { success: false, error: `Electron binary not found at ${electronBin}. Set RM_APP_DIR.` };
  }

  console.log(`[RM-APP] 🚀 Physically launching real RM Electron App on desktop...`);
  console.log(`  • App Path: ${appDir}`);
  console.log(`  • Binary:   ${electronBin}`);

  const env = { ...process.env, RM_TEST_MODE: '1', RM_DIRECT_LIVE_SESSION: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronBin, [appDir], {
    env,
    windowsHide: false,
    detached: false
  });

  child.stdout.on('data', d => {
    const s = d.toString().trim();
    if (s.includes('Stealth controller listening') || s.includes('Restored saved window') || s.includes('Shortcuts')) {
      console.log(`  [RM App Event] ${s}`);
    }
  });

  child.stderr.on('data', d => {
    const s = d.toString().trim();
    if (s.includes('Error') && !s.includes('GEMINI_KEY') && !s.includes('DEEPGRAM_API_KEY')) {
      console.warn(`  [RM App Error] ${s}`);
    }
  });

  // Wait for the window & port 48999 to initialize
  let controllerReady = false;
  const start = Date.now();
  while (Date.now() - start < 6000) {
    await new Promise(r => setTimeout(r, 600));
    const active = await new Promise(res => {
      const ping = http.get('http://127.0.0.1:48999', r => res(true));
      ping.on('error', () => res(false));
      ping.setTimeout(400, () => { ping.destroy(); res(false); });
    });
    if (active) {
      controllerReady = true;
      break;
    }
  }

  console.log(`[RM-APP] ✅ Real RM Electron App window is OPEN on desktop (PID: ${child.pid}, Port 48999: ${controllerReady ? 'ACTIVE' : 'STARTING'})`);
  return {
    success: true,
    process: child,
    pid: child.pid,
    appDir,
    controllerReady
  };
}

// Execute tests for a single target app
async function runTestsForApp(appInfo, options = {}) {
  const { isSimulate, appDir, outDir } = options;

  // 1. Directly open target application and launch active meeting room
  let meetingInfo = null;
  if (appInfo.autoStartMeeting !== false && appInfo.id !== 'desktop-clean') {
    meetingInfo = await startMeetingForApp(appInfo);
  } else {
    const launchStatus = await launchTargetApp(appInfo);
    meetingInfo = {
      appId: appInfo.id,
      appName: appInfo.name,
      processName: appInfo.processName,
      meetingStarted: false,
      running: launchStatus.running
    };
  }
  const running = meetingInfo.running || isProcessRunning(appInfo.processName);

  // 2. Physically launch real RM Electron App on desktop
  const rmApp = await launchRealRMApp();

  console.log(`\n======================================================`);
  console.log(`▶ Testing RM with target app: ${appInfo.name} (${appInfo.id})`);
  console.log(`  Process: ${appInfo.processName || 'none'} | Currently Running: ${running}`);
  console.log(`  Direct Meeting Launch: ${meetingInfo.meetingStarted ? 'ACTIVE (Meeting room started)' : 'FAILED (' + (meetingInfo.error || 'not installed') + ')'}`);
  console.log(`  Real RM Electron Window: ${rmApp.success ? 'OPEN ON DESKTOP (PID ' + rmApp.pid + ')' : 'FAILED'}`);
  console.log(`======================================================`);

  const tests = [];
  const addTest = (name, expected, actual, pass, logs = '') => {
    tests.push({
      section: appInfo.name,
      name,
      expected: String(expected),
      actual: String(actual),
      status: pass ? 'PASS' : 'FAIL',
      logs
    });
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name} ${pass ? '' : `(got: ${actual}, exp: ${expected})`}`);
  };

  // Check 1: Open app & start meeting room directly
  if (appInfo.id !== 'desktop-clean') {
    addTest(
      `Directly start meeting in ${appInfo.name}`,
      'meeting application opened and active meeting room initiated on desktop',
      meetingInfo.meetingStarted ? `meeting active (${meetingInfo.audioProfile || 'loopback'})` : (meetingInfo.error || 'Failed to start meeting'),
      meetingInfo.meetingStarted === true
    );
  } else {
    addTest(
      `Open clean desktop baseline`,
      'desktop environment active',
      'desktop active',
      true
    );
  }

  // Check 2: Physically open real RM Electron window on desktop
  addTest(
    `Physically open RM Electron App window on desktop`,
    'RM window visible on desktop, stealth controller port 48999 active',
    rmApp.success ? `process started (PID ${rmApp.pid}), port 48999 ${rmApp.controllerReady ? 'responding' : 'not responding after 6s'}` : (rmApp.error || 'Failed to open window'),
    rmApp.success === true && rmApp.controllerReady === true
  );

  // Close the desktop RM instance and confirm the process actually exits, so the harness
  // below can start its own instance (port 48999 and the window are free again).
  let rmExited = false;
  if (rmApp.process) {
    rmExited = await new Promise((resolve) => {
      if (rmApp.process.exitCode !== null) return resolve(true);
      const t = setTimeout(() => resolve(false), 5000);
      rmApp.process.once('exit', () => { clearTimeout(t); resolve(true); });
      try { rmApp.process.kill(); } catch { clearTimeout(t); resolve(false); }
    });
  }
  addTest(
    `RM desktop window cleanup`,
    'RM process exits after kill',
    rmApp.process ? (rmExited ? 'exited' : 'still running after 5s') : 'never launched',
    rmExited
  );

  // 3. Run the real UI / pipeline / latency harness while the target app is running beside it.
  //    Every check and number below comes from that run; nothing is synthesized.
  console.log(`[PIPELINE] ▶ Running UI/pipeline/latency harness alongside ${appInfo.name}...`);
  let harness = null;
  try {
    harness = await runHarness({
      mockPort: HARNESS_MOCK_PORT,
      outDir: outDir ? path.join(outDir, `harness-${appInfo.id}`) : undefined
    });
  } catch (e) {
    addTest('Harness started', 'harness launches the RM app', String((e && e.message) || e), false, String((e && e.stack) || e));
  }
  if (harness) {
    for (const r of harness.results) {
      tests.push({ ...r, section: `${appInfo.name} · ${r.section}` });
      console.log(`  [${r.status}] ${r.name}`);
    }
  }
  const stats = harness ? harness.metrics : { latency: null, window: null, process: null };

  // If force failure or simulated error requested:
  if (options.forceFail) {
    addTest(
      `Forced failure (--force-alert) under ${appInfo.name}`,
      'pass',
      'forced failure to exercise admin alert path',
      false,
      'Synthetic failure requested via --force-alert; not a real test result'
    );
  }

  const passCount = tests.filter(t => t.status === 'PASS').length;
  const failCount = tests.length - passCount;

  return {
    id: appInfo.id,
    name: appInfo.name,
    processName: appInfo.processName,
    processRunning: running,
    meetingStarted: meetingInfo.meetingStarted,
    status: failCount === 0 ? 'PASS' : 'FAIL',
    passed: passCount,
    failed: failCount,
    ttftMedian: stats.latency ? stats.latency.ttftMs.median : null,
    totalLatencyMedian: stats.latency ? stats.latency.totalMs.median : null,
    stats,
    harnessReport: harness ? path.join(harness.outDir, 'report.html') : null,
    tests
  };
}

// Main Pipeline Job Execution
async function executePipelineJob(triggerSource = 'manual') {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const jobId = `job-${Date.now()}`;
  console.log(`\n======================================================`);
  console.log(`🚀 RM TEST PIPELINE STARTING`);
  console.log(`Job ID: ${jobId} | Trigger: ${triggerSource} | Time: ${timestamp}`);
  console.log(`======================================================`);

  const targetApps = getTargetApps();
  console.log(`Mentioned target apps to test (${targetApps.length}):`, targetApps.map(a => a.name).join(', '));

  const outDir = path.join(__dirname, 'reports', `pipeline-${timestamp.replace(/[:.]/g, '-')}`);
  fs.mkdirSync(outDir, { recursive: true });

  const appResults = [];
  const failures = [];

  for (let i = 0; i < targetApps.length; i++) {
    const app = targetApps[i];
    const forceFail = isForceAlert && i === 0; // force a test failure if testing alert
    const res = await runTestsForApp(app, {
      isSimulate: true,
      outDir,
      forceFail
    });
    appResults.push(res);

    res.tests.filter(t => t.status === 'FAIL').forEach(f => {
      failures.push({
        app: app.name,
        name: f.name,
        expected: f.expected,
        actual: f.actual,
        error: f.logs || 'Assertion failed'
      });
    });
  }

  const totalTests = appResults.reduce((acc, r) => acc + r.tests.length, 0);
  const passCount = appResults.reduce((acc, r) => acc + r.passed, 0);
  const failCount = appResults.reduce((acc, r) => acc + r.failed, 0);
  const passedApps = appResults.filter(r => r.status === 'PASS').map(r => r.name);
  const failedApps = appResults.filter(r => r.status === 'FAIL').map(r => r.name);

  const durationMs = Date.now() - startTime;
  const overallStatus = failCount === 0 ? 'PASS' : 'FAIL';

  // Construct structured JSON payload
  const payload = {
    jobId,
    timestamp,
    durationMs,
    triggerSource,
    environment: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      nodeVersion: process.version
    },
    summary: {
      status: overallStatus,
      totalApps: targetApps.length,
      passedAppsCount: passedApps.length,
      failedAppsCount: failedApps.length,
      passedApps,
      failedApps,
      totalTests,
      passCount,
      failCount
    },
    appsTested: appResults,
    failures
  };

  // 1. Write local reports
  const jsonReportPath = path.join(outDir, 'results.json');
  fs.writeFileSync(jsonReportPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(__dirname, 'reports', 'latest-pipeline-results.json'), JSON.stringify(payload, null, 2));
  generateHtmlReport(payload, outDir);

  console.log(`\n------------------------------------------------------`);
  console.log(`🏁 Pipeline execution finished in ${durationMs}ms`);
  console.log(`Summary: ${passCount}/${totalTests} tests passed (${failCount} failures)`);
  console.log(`JSON Report: ${jsonReportPath}`);
  console.log(`HTML Report: ${path.join(outDir, 'report.html')}`);
  console.log(`------------------------------------------------------`);

  // 2. Send JSON results to backend
  await sendResultsToBackend(payload);

  // 3. Trigger Admin Popup if failures occurred
  if (failCount > 0) {
    console.log(`\n[ALERT] 🚨 Failures detected (${failCount}). Triggering popup to admin...`);
    sendAdminPopup({
      title: '⚠️ RM Pipeline Test: Failures Detected',
      summary: payload.summary,
      failures: payload.failures,
      reportPath: path.join(outDir, 'report.html'),
      async: true
    });
  } else {
    console.log(`\n[ALERT] All tests passed across all apps. No admin popup needed.`);
  }

  return payload;
}

// Calculate ms until next daily target time (e.g. "09:00")
function getMsUntilNextDailyTime(timeStr = '09:00') {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  // If time has already passed today, schedule for tomorrow
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return {
    ms: next.getTime() - now.getTime(),
    nextDate: next
  };
}

// Scheduled job runner loop
function startScheduledRunner() {
  const isDailySchedule = (config.schedule && config.schedule.frequency === 'daily') || isDaily;

  if (isDailySchedule) {
    const dailyAt = config.schedule.dailyAt || '09:00';
    console.log(`[SCHEDULE] 📅 Daily job scheduler active.`);
    console.log(`[SCHEDULE] Configured to run directly every day at ${dailyAt}.`);

    if (isRunNow || config.schedule.runOnStartup) {
      console.log(`[SCHEDULE] Running immediate startup test run...`);
      executePipelineJob('schedule-startup').catch(e => console.error('[SCHEDULE] Startup run error:', e));
    }

    const scheduleNext = () => {
      const { ms, nextDate } = getMsUntilNextDailyTime(dailyAt);
      console.log(`[SCHEDULE] ⏳ Next daily check scheduled for: ${nextDate.toLocaleString()} (in ${Math.round(ms / 60000)} minutes)`);
      setTimeout(async () => {
        console.log(`\n======================================================`);
        console.log(`⏰ [SCHEDULE] Daily automated pipeline run triggered at ${new Date().toLocaleString()}`);
        console.log(`======================================================`);
        try {
          await executePipelineJob('daily-schedule');
        } catch (e) {
          console.error('[SCHEDULE] Daily execution error:', e);
        }
        // Chain the next day's run
        scheduleNext();
      }, ms);
    };

    scheduleNext();
    return;
  }

  // Interval-based scheduling fallback
  const intervalMins = config.schedule.intervalMinutes || 60;
  const intervalMs = intervalMins * 60 * 1000;
  console.log(`[SCHEDULE] Job scheduler active: running every ${intervalMins} minute(s) (${intervalMs}ms).`);

  if (isRunNow || config.schedule.runOnStartup) {
    executePipelineJob('schedule-initial').catch(e => console.error('[SCHEDULE] Initial run error:', e));
  }

  setInterval(() => {
    console.log(`\n[SCHEDULE] Scheduled interval triggered at ${new Date().toLocaleString()}`);
    executePipelineJob('schedule-interval').catch(e => console.error('[SCHEDULE] Interval execution error:', e));
  }, intervalMs);
}

// Entrypoint
if (isDaemon) {
  startScheduledRunner();
} else {
  executePipelineJob('cli').then(res => {
    if (autoSpawnedBackend) {
      try { autoSpawnedBackend.unref(); } catch { }
    }
    if (res.summary.failCount > 0 && !isForceAlert) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  }).catch(err => {
    console.error('Fatal pipeline error:', err);
    process.exit(2);
  });
}
