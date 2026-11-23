# Audio → AI → Overlay pipeline: inspection & test strategy

Scope: validate the functional copilot pipeline (audio in → transcript → AI answer → overlay)
and the overlay's own UI. **Out of scope:** screen-capture invisibility / concealment from Zoom,
and any automated participation in a real meeting. Nothing here modifies production behavior yet.

## 1. Architecture (as built, with file references)

```
 System audio (loopback)                      ┌────────────── Electron main (main.js) ───────────────┐
 + microphone                                 │                                                       │
   │ getUserMedia(desktop audio) r:4050       │  ipcMain 'start-transcription'  → Deepgram WSS        │
   │ getUserMedia(audio) r:4128               │    wss://api.deepgram.com/v1/listen                   │
   ▼                                          │    model=nova-3 encoding=linear16 sr=16000 ch=1       │
 AudioContext → ScriptProcessor(4096) r:3767  │    endpointing=10 interim_results smart_format  m:800 │
   │ downsampleAndConvertToInt16 → 16k mono    │       │ 'message' → transcript, is_final              │
   │ PCM  r:3716                               │       ▼                                               │
   └── IPC sendAudioChunk ──────────────────▶ │  forwards PCM to Deepgram  m:~850                     │
                                              │       │ IPC 'transcription-chunk' {text,is_final,lang}│
 ┌──────────── Electron renderer (renderer.js) ◀──────┘                                               │
 │ onTranscriptChunk r:3841 → handleTranscriptChunk r:3920                                            │
 │ accumulate is_final blocks r:3684 ; question detection r:3850 (≤1 answer per question)             │
 │       │ on question / Answer button                                                                │
 │       └── IPC query-backend-stream ───────▶ main m:1277 → POST /api/answer/stream (BACKEND_URL)    │
 │                                              default https://round-mate-ai.onrender.com m:44       │
 │             streamed tokens  ◀── IPC 'answer-chunk' ──┘ (fallback /api/answer m:1259;              │
 │       ▼                                                 offline query-gemini m:927)                │
 │ renderAnswerToDOM r:4325/4388 → scrolling answer panel ; question pinned at top r:4296             │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
   Overlay window: 600x580 frame:false transparent alwaysOnTop m:511 ; bounds persisted to
   userData/stealth_window_state.json  (loadSavedBounds m:264 / saveSavedBounds m:297)
```

## 2. Pipeline facts

| Stage | Implementation | Notes |
|---|---|---|
| Audio capture | `renderer.js:4039-4101` loopback (`getUserMedia` desktop audio via `desktopCapturer` source `main.js:753`); mic `:4128` | permission = Electron media access; device selection = default desktop/mic |
| Audio format | `downsampleAndConvertToInt16` `:3716`, `ScriptProcessor(4096,1,1)` `:3767` | **Linear16 PCM, 16 kHz, mono**; input SR resampled from `audioCtx.sampleRate` |
| Transcription | Deepgram **nova-3**, WSS `main.js:800` | `endpointing=10`, `interim_results`, `smart_format`, `language` or `detect_language`; emits `transcription-chunk` |
| Question detection | `renderer.js:3850-3860`, `handleTranscriptChunk :3920` | accumulates finals; at most one answer per question; manual "Answer" button path too |
| AI request | IPC `query-backend-stream` `main.js:1277` → `POST /api/answer/stream` | streaming; non-stream `/api/answer :1259`; offline `query-gemini :927` |
| Answer render | `renderAnswerToDOM :4325/:4388` | streamed tokens appended; question pinned `:4296`; scrolling panel |
| Overlay window | `main.js:511` create, bounds `:264/:297`, shortcuts `:653`, tray `:2280`, minimize/close `:1733/:1739` | |

## 3. Integration points (clean test seams — no Zoom, no concealment)

These IPC/HTTP boundaries let each stage be driven deterministically:

1. **`sendAudioChunk` IPC** — inject prerecorded, consented PCM to exercise audio→STT→answer end to end.
2. **`transcription-chunk` IPC** — inject synthetic transcripts to test question-detection → answer → overlay
   with no Deepgram key and no audio (fully deterministic; best for regression).
3. **`query-backend-stream` / `query-backend` IPC** — point at a **local fake backend** to test overlay
   rendering, streaming, long-answer scrolling, and error/incomplete handling without a real LLM.
4. **`BACKEND_URL` env** — redirect `/api/answer/stream` to a local stub for end-to-end latency timing.
5. **Deepgram WSS** — optionally redirect to a local WS mock to test STT message parsing/reconnect.

## 4. Test strategy

### A. Overlay UI regression (automated, Playwright `_electron`, no Zoom)
Launch the real app isolated with `--user-data-dir=<temp>` (protects the user's saved window state and
sidesteps the single-instance lock). Tests: startup/init, window bounds + `stealth_window_state.json`
persistence, resize, reposition + on-screen clamping (`clampBoundsToScreen`), global shortcuts register,
minimize/restore, tray show/hide, quit cleanup, restart recovery. Screenshots of the normal visible UI.
Requires one guarded change first (see §6): skip the 5 s auto-updater under `RM_TEST_MODE=1` so it can't
relaunch mid-test.

### B. Pipeline regression (automated, via seams 2 & 3)
Drive `transcription-chunk` with scripted question sets — technical, behavioral, situational; with pauses,
duplicate finals, and non-question chatter — against a local fake backend. Assert: exactly one answer per
question, no dropped/duplicated questions, answer appears and scrolls, incomplete/`error` responses are
handled, overlay recovers after a backend failure.

### C. Latency (automated, via seams 1/4)
Timestamp t0 PCM sent → t1 final transcript → t2 first answer token → t3 answer complete. Report
STT latency (t1−t0), time-to-first-token (t2−t1), total (t3−t0). Use a local echo backend to isolate
app overhead from network/LLM.

### D. Accuracy (manual harness, consented audio only)
Feed prerecorded clips (clear speech, accents, noise) through seam 1; compare transcripts to references
for WER. Not a unit test — a measurement run with stored, consented audio.

### E. "Zoom running" compatibility (read-only)
Start/stop Zoom beside the app (manually) and assert via the harness that the app window/process stays
stable. **Only observes the app's own stability** — it does not inspect, hide from, or touch Zoom.

## 5. Known limitations
- **No real-meeting run in this session.** A live Zoom interview run is the product's concealment use case;
  I won't automate it. Seams 1–4 cover audio-to-answer and latency deterministically and more repeatably.
- STT accuracy depends on a Deepgram key (not needed for B/C, which use seam 2).
- Backend latency figures from a stub exclude the real LLM; real figures need the production backend.
- macOS/Linux loopback audio differs; this strategy targets the Windows build.

## 6. One guarded production change this needs (not yet applied)
`main.js:2356` auto-updater can download+relaunch 5 s after start. For stable tests, wrap it so it is
skipped only when `process.env.RM_TEST_MODE === '1'` — inert in normal runs, touches nothing about
capture protection or audio. Pending your approval before any edit.
```
if (process.env.RM_TEST_MODE !== '1') {   // ← only this guard added
  setTimeout(async () => { /* existing updater block, unchanged */ }, 5000);
}
```
