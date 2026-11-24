# RM Electron Automated Test Pipeline

This pipeline provides automated regression testing for the **RM (RoundMate / Sutra AI) Electron Desktop App** across multiple target apps (e.g. Zoom, Microsoft Teams, Google Chrome/Meet, Slack, etc.).

It runs automatically on a scheduled job, sends updates in structured JSON format to your backend API, and displays an immediate desktop popup dialog to the system administrator whenever test failures occur.

---

## 🌟 Key Features

1. **Target App Auto-Opening**: Automatically launches/opens each target app mentioned (Zoom, Teams, Chrome, Slack, etc.) before running the check.
2. **Direct-to-Live-Session Mode**: On launch, the RM app bypasses the home screen and directly transitions into an active **Live Session** (`RM_DIRECT_LIVE_SESSION=1`).
3. **Verification Suite (real measurements only)**: for each target app, the pipeline runs the full
   `run.cjs` harness (strategies A/B/C) while that app is running, and reports its results verbatim:
   - Overlay UI: startup, visibility, always-on-top, positioning/resize, saved-bounds persistence,
     global shortcuts, minimize/restore, hide/show, cleanup, restart recovery.
   - Answer pipeline against a local mock backend: streaming, long answers, failures, recovery.
   - Latency (TTFT / total / chunks per second) and Electron process memory & CPU.
   - Audio loopback and Deepgram transcription are **not** measured by the pipeline; those fields are
     absent rather than filled with placeholder values.
4. **Flexible Scheduling**:
   - Runs directly on a daily schedule (e.g. 09:00 AM) or interval.
   - Native Windows Task Scheduler integration via `setup-schedule.ps1`.
   - Node.js background daemon mode (`npm run pipeline:daily`).
5. **Backend JSON Ingestion**:
   - Dispatches a standard JSON payload via HTTP POST to your backend (`/api/test-results`).
   - Tracks job ID, per-app breakdown, test-by-test results, latencies, and failures.
   - Includes automatic retry with backoff and offline local backup.
6. **Instant Admin Failure Popup**:
   - If any test fails during the live session check, an alert popup (`MessageBox` with Error icon & `TopMost`) is presented directly on the administrator's desktop.
   - Triggers Windows Action Center notifications.

---

## 📁 Architecture & File Layout

```
rm-electron-ui-tests/
├── pipeline.config.json    # Target apps list, schedule, backend URL, and notification config
├── pipeline-runner.cjs     # Main pipeline engine & orchestrator
├── admin-alert.cjs         # Windows Desktop Popup & Toast notification module
├── mock-backend.cjs        # Backend mock with /api/test-results & /api/answer/stream
├── setup-schedule.ps1      # Windows Task Scheduler manager (register/status/run)
├── run.cjs                 # Core Electron Playwright test harness
├── reports/                # Timestamped JSON results, HTML reports, and screenshots
└── PIPELINE.md             # This guide
```

---

## 🚀 Quick Start

### 1. Run the Pipeline on Demand
To run the automated tests once across all apps mentioned in `pipeline.config.json`:
```powershell
node pipeline-runner.cjs
# or
npm run pipeline
```

### 2. Specify Specific Target Apps via CLI
You can mention specific apps directly using `--apps`:
```powershell
node pipeline-runner.cjs --apps "Zoom,Teams,Chrome"
```

### 3. Test Admin Failure Popup
Verify that the admin desktop popup and notification display properly:
```powershell
node admin-alert.cjs
# or simulate a failing pipeline run:
node pipeline-runner.cjs --test-alert
```

---

## ⏰ Scheduling the Job (Daily Automated Checks)

### Option A: Windows Task Scheduler (Recommended for Windows)
Directly registers a native Windows Scheduled Task that wakes up and runs every day:
```powershell
# Register to check directly every day at 09:00 AM (default):
powershell -ExecutionPolicy Bypass -File .\setup-schedule.ps1 -Action register -Frequency Daily -DailyAt "09:00"

# Register to check every day at a custom time (e.g. 08:30 AM):
powershell -ExecutionPolicy Bypass -File .\setup-schedule.ps1 -Action register -DailyAt "08:30"

# Check scheduled task status & next run time:
powershell -ExecutionPolicy Bypass -File .\setup-schedule.ps1 -Action status

# Trigger an immediate run anytime:
powershell -ExecutionPolicy Bypass -File .\setup-schedule.ps1 -Action run-now

# Unregister when no longer needed:
powershell -ExecutionPolicy Bypass -File .\setup-schedule.ps1 -Action unregister
```

### Option B: Node.js Background Daemon (Direct Daily Execution)
Run continuously as a Node service that executes daily at the configured time:
```powershell
# Run daily at 09:00 AM:
node pipeline-runner.cjs --daily

# Run immediately once on startup AND schedule daily at 09:00 AM:
node pipeline-runner.cjs --daily --run-now

# Run daily at a custom time (e.g. 10:30 PM):
node pipeline-runner.cjs --daily --daily-at "22:30"
```

---

## ⚙️ Configuration (`pipeline.config.json`)

```json
{
  "apps": [
    {
      "id": "zoom",
      "name": "Zoom Workplace",
      "processName": "Zoom.exe",
      "enabled": true
    },
    {
      "id": "teams",
      "name": "Microsoft Teams",
      "processName": "ms-teams.exe",
      "enabled": true
    },
    {
      "id": "chrome-meet",
      "name": "Google Chrome (Meet)",
      "processName": "chrome.exe",
      "enabled": true
    }
  ],
  "schedule": {
    "enabled": true,
    "intervalMinutes": 60
  },
  "backend": {
    "url": "http://127.0.0.1:48888/api/test-results",
    "timeoutMs": 10000,
    "retryCount": 3,
    "authToken": ""
  },
  "notifications": {
    "adminPopup": {
      "enabled": true,
      "onFailureOnly": true
    }
  }
}
```

---

## 📡 Backend JSON Payload Schema

When a job completes, it sends an HTTP POST to `${BACKEND_URL}/api/test-results` with the following JSON body:

```json
{
  "jobId": "job-1711234567890",
  "timestamp": "2026-11-23T11:50:00.000Z",
  "durationMs": 3420,
  "triggerSource": "schedule-interval",
  "environment": {
    "platform": "win32",
    "release": "10.0.26100",
    "arch": "x64",
    "hostname": "WORKSTATION-01",
    "nodeVersion": "v25.9.0"
  },
  "summary": {
    "status": "PASS",
    "totalApps": 3,
    "passedAppsCount": 3,
    "failedAppsCount": 0,
    "passedApps": ["Zoom Workplace", "Microsoft Teams", "Google Chrome (Meet)"],
    "failedApps": [],
    "totalTests": 15,
    "passCount": 15,
    "failCount": 0
  },
  "appsTested": [
    {
      "id": "zoom",
      "name": "Zoom Workplace",
      "processName": "Zoom.exe",
      "processRunning": true,
      "status": "PASS",
      "passed": 5,
      "failed": 0,
      "ttftMedian": 45,
      "totalLatencyMedian": 401,
      "stats": { "latency": { "backend": "local mock", "runs": 12, "ttftMs": { "median": 45, "p95": 46 } }, "process": { "workingSetMb": 363 } },
      "tests": [
        {
          "name": "Overlay compatibility alongside Zoom Workplace",
          "expected": "overlay stays visible and always-on-top",
          "actual": "overlay visible, alwaysOnTop=true",
          "status": "PASS"
        }
      ]
    }
  ],
  "failures": []
}
```

If `summary.failCount > 0`, the `failures` array contains each failed test, and the admin popup is immediately triggered on the desktop.

---

## 🔔 Admin Popup Alert Details

When test failures occur:
1. **Windows GUI Dialog**: Spawns an on-screen `MessageBox` with:
   - ⚠️ Error / Warning Icon
   - `TopMost` flag ensuring it is displayed on top of open application windows
   - Summary of failed apps, test counts, and error descriptions
   - Absolute path to the generated HTML & JSON report
2. **Windows Action Center Notification**: Dispatches a native Windows notification toast.
