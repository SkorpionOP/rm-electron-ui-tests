# rm-electron-ui-tests

Local, Zoom-free regression harness for the RM Electron desktop app. It drives the **real**
application through Playwright's Electron launcher against a **local mock backend**, and checks:

- **UI (Strategy A):** startup, overlay init, window positioning/resize, saved-bounds persistence,
  global keyboard shortcuts, minimize/restore, tray-style hide/show, cleanup on close, restart recovery,
  long-answer scrolling.
- **Pipeline (Strategy B):** the `query-backend-stream` IPC path — token streaming, completion,
  long answers, multiple sequential questions, dropped/partial streams, HTTP 500, empty and malformed
  responses, and recovery.
- **Latency (Strategy C):** app-measured time-to-first-token and total answer latency (median / p95 / max).

It does **not** join or automate a real meeting, capture a screen, or test capture invisibility /
concealment. All data is synthetic or served by the bundled mock backend.

## Requirements
- Node.js 18+ and Windows (the app targets the Windows Electron build).
- A checkout of the RM app (**Sutra-AI-APP**) with its dependencies installed (`npm install` there),
  so this harness can launch its Electron binary and `main.js`.
- The app must honor `RM_TEST_MODE=1` (skips the auto-updater; allows a test backend via
  `RM_TEST_BACKEND_URL`). The harness sets these automatically.

## Install (reproducible)
```sh
npm ci
```
`playwright-core` is pinned in `package-lock.json`.

## Run
```sh
# point at your Sutra-AI-APP checkout
RM_APP_DIR=/path/to/Sutra-AI-APP npm test
# Windows PowerShell:  $env:RM_APP_DIR="C:\path\to\Sutra-AI-APP"; npm test
```
Each run writes a timestamped folder under `reports/` (gitignored) with `report.html`,
`results.json`, and screenshots of the normal visible overlay UI. A representative passing
run is kept in `sample-report/`.

## Automated Test Pipeline (Scheduled + Multi-App + Backend Sync + Admin Popups)

For scheduled regression testing across all mentioned target apps (Zoom, Teams, Chrome/Meet, Slack, etc.):

```sh
# Run pipeline once across mentioned apps:
node pipeline-runner.cjs
# Or specify specific target apps:
node pipeline-runner.cjs --apps "Zoom,Teams,Chrome"

# Run as a background scheduled daemon (e.g. every 60 mins):
node pipeline-runner.cjs --schedule --interval 60

# Register to check directly every day via Windows Task Scheduler (e.g. 09:00 AM):
powershell -ExecutionPolicy Bypass -File .\setup-schedule.ps1 -Action register -Frequency Daily -DailyAt "09:00"

# Or run as a daily background daemon:
node pipeline-runner.cjs --daily --daily-at "09:00"
```

- Target apps are configured in [pipeline.config.json](file:///c:/Users/omkar/Downloads/rm-electron-ui-tests/pipeline.config.json).
- Sends full test results in JSON format to your backend at `POST /api/test-results`.
- If failures occur, immediately triggers an on-screen **Admin Popup Alert** (`MessageBox` TopMost + Windows notification).
- Detailed documentation: [PIPELINE.md](file:///c:/Users/omkar/Downloads/rm-electron-ui-tests/PIPELINE.md).

## Files
- `pipeline-runner.cjs` — automated pipeline orchestrator for mentioned apps, scheduling, JSON backend sync & admin alerts.
- `pipeline.config.json` — list of target apps, scheduling intervals, backend API endpoints, and notifications.
- `admin-alert.cjs` — Windows GUI desktop popup and action center alert system.
- `setup-schedule.ps1` — Windows Task Scheduler registration script.
- `run.cjs` — the harness (all three strategies + report generation).
- `mock-backend.cjs` — local stand-in for `/api/answer/stream` and `/api/test-results` results ingestion.
- `TEST-STRATEGY.md` — architecture, integration seams, strategy, and known limitations.
- `PIPELINE.md` — full pipeline design and configuration guide.
- `sample-report/` — a representative passing run (28/28).

## Notes
- Make sure the RM app is **not already running** when you start a run (single-instance lock).
- The harness launches the app with an isolated `--user-data-dir`, so your real window state is untouched.
