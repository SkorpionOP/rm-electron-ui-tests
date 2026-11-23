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

## Files
- `run.cjs` — the harness (all three strategies + report generation).
- `mock-backend.cjs` — local stand-in for `/api/answer/stream`; scenarios are selected by a
  `[[scenario:NAME]]` marker in the synthetic request. Stores no request content.
- `TEST-STRATEGY.md` — architecture, integration seams, strategy, and known limitations.
- `sample-report/` — a representative passing run (28/28).

## Notes
- Make sure the RM app is **not already running** when you start a run (single-instance lock).
- The harness launches the app with an isolated `--user-data-dir`, so your real window state is untouched.
