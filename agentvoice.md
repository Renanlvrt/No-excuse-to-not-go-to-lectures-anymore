# AGENT PROMPT — Replace mic capture with a Live Voice Transcription Pipeline (in THIS repo, without breaking anything else)

You are working in the existing repo `No-excuse-to-not-go-to-lectures-anymore`
(a FastAPI + vanilla-JS app that turns lecture speech into a live,
color-coded mind-map). Read `why.md` at the repo root first — it documents,
with exact file/line references, how the CURRENT mic-capture path works
(browser `SpeechRecognition` API, no audio bytes ever sent anywhere) and
how it feeds the concept-graph extraction pipeline. Everything in this
prompt assumes you've read that.

**Your task**: rip out the current `SpeechRecognition`-based capture path
and replace it with the exact pipeline specified in PART B below (raw
PCM16 capture → IndexedDB local buffer → backend relay → ElevenLabs
Scribe Realtime → live partial/committed transcript → cloud-storage
upload on stop → reconnect/backoff). PART B is the original, precise spec
— follow it exactly, in order, skipping nothing.

**The constraint that makes this different from building the spec from
scratch**: this repo already has a working, unrelated feature (speech/typed
text → Gemini → live concept mind-map) sharing some of the same files.
PART A tells you exactly what must NOT change and how the new pipeline
plugs into what's already there. Where PART A and PART B conflict on
file layout (PART B assumes a blank repo with `static/index.html` and a
single `main.py`), **PART A wins** — adapt PART B's file paths into this
repo's existing structure; do not restructure the existing project to
match PART B's assumed layout.

---

## PART A — How this fits into the existing repo

### A1. Do NOT touch (verify by re-reading `why.md` / the file itself before editing anything nearby)

- `backend/services/diagram.py`, `qa.py`, `imagegen.py`, `widgetgen.py`,
  `videogen.py`, `quizgen.py`, `summarygen.py`, `cache.py`, `enrich.py` —
  entirely unrelated to voice capture. Do not open these with edits in
  mind.
- `backend/services/transcribe.py` — this is a **different, already-dead**
  ElevenLabs integration (one-shot `speech_to_text.convert`, not the
  realtime WebSocket API this task needs). Leave it exactly as-is,
  unused. Do not delete it, do not repurpose it, do not let the new
  realtime relay code live in this file — name your new relay code
  something else (e.g. `backend/services/scribe_relay.py`) so the two
  are never confused.
- In `backend/main.py`: the `/ws/lecture` websocket handler
  (`lecture_ws`), `receive_loop()`, `extraction_loop()`,
  `run_extraction()`, `handle_node_action()`, `handle_generate_video()`,
  and every existing route/import tied to them. You are ADDING new
  routes alongside these, not modifying them.
- In `frontend/app.js`: the entire d3-force simulation block, `mergeGraph`,
  node/card rendering, the right-side panel logic, every `generate_*`
  message sender (`ask`, `generate_image`, `generate_widget`,
  `generate_video`, `generate_check`, `generate_quiz`,
  `generate_summary`), the quiz/wrap-up overlay code, and the existing
  `connect()` function that opens the `/ws/lecture` socket (you will
  call into it, not rewrite it).
- The `manualInput` textarea and its existing `input` listener
  (`app.js`) — the type-instead-of-speak fallback stays exactly as it is.

### A2. What you're replacing (and where it currently lives, per `why.md` §3, §5)

In `frontend/app.js`, remove entirely:
- `const SpeechRecognition = ...`
- `let fullTranscript = ""` (superseded by IndexedDB-backed committed
  lines — see A3 for the one place its *role* is preserved)
- `let recognitionInstance = null`
- `function startRecognition() { ... }`
- `function stopListeningDueToMicError(...) { ... }`
- the `recognition.onresult` / `onerror` / `onend` block

Keep and reuse (don't recreate parallel versions of these):
- `startBtn` element and the fact that clicking it toggles a single
  boolean recording state — reuse the existing `listening` variable's
  role (true while capturing) and the existing `startBtn.onclick`
  handler's shape (start branch / stop branch), just swap what happens
  inside each branch for the new PCM16/WS pipeline (PART B, Step 1 and
  Step 5.1).
- `setStatus()` and `showToast()` helpers already in `app.js` — use
  these for the new status/error UI wherever they reasonably fit
  (connection status, transient errors) instead of inventing a parallel
  notification system. The one exception: PART B's terminal-error "red
  error banner" (auth_error/quota_exceeded/etc.) must stay visible until
  the user acts (not auto-dismiss like a toast) — add one dedicated,
  persistent error-banner element for exactly those cases; use
  `showToast` for everything else.
- The existing `#transcript` div (`transcriptEl` in `app.js`,
  `frontend/index.html`) as the single place committed + partial voice
  text is displayed — append committed lines into it and keep one
  trailing italic partial-text node, rather than adding a second,
  redundant transcript panel elsewhere on the page.

### A3. Required integration bridge (the one deliberate cross-wire)

The whole reason this app has a mic in the first place is to feed the
existing concept-graph extraction (`why.md` §2, §4: frontend sends
`{"text": "<cumulative transcript>"}` over the **existing** `/ws/lecture`
socket; `receive_loop`'s default branch sets
`state["transcript"] = msg["text"]`; `extraction_loop` turns that into
the mind-map). That must keep working. So:

- Every time a `committed_transcript` / `committed_transcript_with_timestamps`
  event finalizes a line (PART B, Step 4), in addition to storing it in
  IndexedDB and rendering it, **also** append it to a running cumulative
  string and send it over the pre-existing `/ws/lecture` socket exactly
  the way the old `SpeechRecognition.onresult` handler used to:
  ```js
  ws.send(JSON.stringify({ text: (cumulativeVoiceText + " " + manualInput.value).trim() }));
  ```
  (`ws` here is the *existing* `/ws/lecture` socket/`connect()` from
  A1 — do not open a second connection to it, and do not touch
  `receive_loop`/`extraction_loop` on the backend to make this work;
  they already handle arbitrary `{"text": ...}` messages correctly.)
- This is the only place the new pipeline talks to the old one. The new
  `/ws/transcribe` socket (PART B) and the old `/ws/lecture` socket are
  two independent, simultaneously-open connections from the same page;
  don't merge them into one endpoint.

### A4. File-by-file plan

**Add:**
- `backend/services/scribe_relay.py` — optional home for any relay
  helper logic you want out of `main.py` (e.g. the two forwarding
  coroutines), if you want to mirror the existing `services/`
  convention. The `@app.websocket("/ws/transcribe")` route declaration
  itself should live in `backend/main.py`, next to `/ws/lecture`, matching
  how the one existing websocket route is declared there today.
- `backend/services/transcript_storage.py` — `save_to_cloud(data: dict) -> str`
  placeholder per PART B Step 5.4, writing to `./storage/<session_id>.json`,
  with the required `# TODO: replace with S3/GCS/Azure upload` comment.
  Create the `storage/` dir the same way `cache.py` creates `data/`
  (`Path("storage").mkdir(exist_ok=True)`).
- The `TranscriptUpload` pydantic model for `POST /api/transcript` can be
  defined inline in `backend/main.py` right above the route (this repo
  has no existing `schemas.py`; don't introduce one for a single model).

**Edit:**
- `backend/main.py` — add the `@app.websocket("/ws/transcribe")` relay
  route and the `@app.post("/api/transcript")` route (PART B, Step 3 and
  Step 5.4), reusing the existing `ELEVENLABS_API_KEY` module-level
  variable (already read at the top of this file for video generation —
  don't read it a second time under a different name). Add `import
  websockets`, `import json`, `import logging` (or reuse an existing
  logger if one exists) at the top alongside the current imports.
  Everything else in this file is additive — no existing line should
  need to change.
- `frontend/index.html` — add: a connection-status indicator
  (🟢/🟡/🔴) near `startBtn`, the persistent error-banner element from
  A2, a "Retry upload" button (hidden by default). Do not remove or
  rename any existing element id that `app.js` already references.
- `frontend/app.js` — per A2/A3 above: remove the `SpeechRecognition`
  block, add the full PCM16/IndexedDB/relay pipeline from PART B.
- `.gitignore` — add `storage/` alongside the existing `data/` entry
  (same reasoning: local runtime output, not source).
- `requirements.txt`, `.env.example` — likely **no changes needed**:
  `fastapi`, `uvicorn[standard]`, `websockets`, `python-dotenv`,
  `python-multipart` are already listed, and `ELEVENLABS_API_KEY` is
  already in `.env.example`. Double-check versions meet PART B's
  minimums; bump only if actually below them.

### A5. Definition of done (adapted)

All of PART B's original checklist, plus:
- [ ] The existing mind-map/extraction feature still works end-to-end,
      unchanged, when driven by the new voice pipeline (spoken word →
      committed line → mind-map updates within one `EXTRACTION_INTERVAL_SECONDS`
      cycle) — verifies the A3 bridge didn't break or bypass it.
- [ ] Every other existing feature (ask a node, generate image/widget/
      video, quiz, wrap-up summary, manual-text fallback) still works
      with zero code changes to their files.
- [ ] `git diff` touches only the files listed in A4 — nothing under
      `backend/services/{diagram,qa,imagegen,widgetgen,videogen,quizgen,summarygen,cache,enrich,transcribe}.py`
      is modified.

---

## PART B — Original exact specification (follow verbatim; adapt only file *paths* per PART A)

### YOUR TASK
Build a real-time voice transcription pipeline with this EXACT data flow. Do not change the order of steps. Do not skip any step.

```
🎙️ Microphone
      ↓
Audio chunks (raw PCM16 mono, 16000 Hz, 4096 samples ≈ 256ms each)
      ↓
IndexedDB (local buffer — save every chunk BEFORE sending)
      ↓
ElevenLabs Scribe Realtime (live speech-to-text, via backend relay)
      ↓
📝 Final Transcript (partial text shown live, committed text appended)
      ↓
☁️ Cloud Storage (upload the finished transcript)
      ↓
Backend confirms & stores metadata
```

### TECH STACK (use exactly this)
- Frontend: vanilla JavaScript, no frameworks, no build step, no npm packages, served by the FastAPI app (per PART A: this means `frontend/index.html` + `frontend/app.js` in this repo, not a new `static/index.html`).
- Backend: Python + FastAPI + the `websockets` library (per PART A: added into the existing `backend/main.py`, not a new standalone file).
- Speech-to-text: ElevenLabs Scribe Realtime WebSocket API.
- Local buffer: IndexedDB (browser built-in database).
- Cloud storage: backend endpoint `POST /api/transcript` that calls a placeholder `save_to_cloud(data)` (real provider wired later).

### STEP 1 — Microphone capture (frontend)
1. On "Record" button click, run two guards BEFORE anything else:
   - Guard 1: `window.isSecureContext` must be true (mic requires `https://` or `http://localhost`). If false → show error, stop.
   - Guard 2: `navigator.mediaDevices.getUserMedia` must exist. If not → show "browser not supported" error, stop.
2. Call `navigator.mediaDevices.getUserMedia({ audio: true })` — exactly this, no extra constraints.
3. Branch mic errors on `err.name`:
   - `NotAllowedError` or `PermissionDeniedError` → "Microphone permission denied."
   - `NotFoundError` → "No microphone found."
   - anything else → generic error message.
4. Create `new AudioContext({ sampleRate: 16000 })` (with `webkitAudioContext` fallback).
5. `audioCtx.createMediaStreamSource(micStream)` to pull the mic into the audio graph.
6. `audioCtx.createScriptProcessor(4096, 1, 1)` — 4096-sample buffer, 1 input channel, 1 output channel. (`ScriptProcessorNode` is deprecated but deliberately chosen for simplicity: universally supported, no separate AudioWorklet module file. Add a code comment saying exactly this.)
7. Connect the graph: source → processor → GainNode with `gain.value = 0` → `audioCtx.destination`. The silent GainNode keeps the graph "live" (some browsers stop firing `onaudioprocess` if the chain doesn't reach the destination) without echoing the mic to the speakers. Comment this in the code.
8. In `processor.onaudioprocess`:
   - `const float32 = e.inputBuffer.getChannelData(0);`
   - Convert Float32 → Int16 PCM little-endian (write a `floatTo16BitPCM` helper: clamp each sample to [-1, 1], multiply by 0x7FFF).
   - Base64-encode the Int16 bytes (write a `base64FromInt16` helper).
   - Each callback fires every ~4096 samples ≈ ~256ms of audio at 16kHz. Send immediately — no batching, no setInterval.

### STEP 2 — Save every chunk to IndexedDB FIRST
Every chunk is written to IndexedDB BEFORE it is sent over the network. IndexedDB is the safety buffer — if any connection drops, no audio is lost.
1. On app load, open IndexedDB database `transcriber` (version 1) with two object stores:
   - `chunks` — keyPath: auto-increment `id`. Record shape: `{ id, sessionId, seq, base64Audio, sentAt: null, createdAt }`
   - `transcripts` — keyPath: `sessionId`. Record shape: `{ sessionId, lines: [], status: "recording" | "done" | "uploaded", createdAt }`
2. When recording starts, generate `sessionId = crypto.randomUUID()` and create the session's `transcripts` record with `status: "recording"`.
3. For EVERY audio chunk: `put` into `chunks` with an incrementing `seq`, and only THEN send over the WebSocket.
4. After `ws.send()` succeeds, update that chunk's record: `sentAt = Date.now()`.
5. If the WebSocket is closed/failed, DO NOT stop capture — keep writing chunks with `sentAt: null` (the "unsent backlog").
6. On reconnect (Step 6): read all current-session chunks where `sentAt === null`, ordered by `seq`, send them first, then resume live streaming.
7. After a session's transcript is uploaded successfully (Step 5), delete all that session's chunks from IndexedDB.

### STEP 3 — Send chunks to backend; backend relays to Scribe
**Frontend → Backend:**
1. ONE WebSocket to `/ws/transcribe`. Build the URL dynamically: (`location.protocol === "https:" ? "wss://" : "ws://"`) + `location.host` + `/ws/transcribe`. Same host and port as the page — no hardcoded host.
2. Open the WebSocket and await `onopen` BEFORE building the audio graph — a failed backend connection must be caught before any capture starts.
3. Exact chunk frame (JSON text frame):
   ```json
   {
     "message_type": "input_audio_chunk",
     "audio_base_64": "<base64 of Int16 PCM bytes>",
     "sample_rate": 16000,
     "commit": false
   }
   ```
   `commit` is ALWAYS `false` from the client. Finalization is decided entirely by Scribe's server-side voice-activity detection (`commit_strategy=vad`) — there is no client-side commit signal.

**Backend relay (per PART A: inside `backend/main.py`):**
1. Load env with python-dotenv (already done in this repo). Module/route-level comment must state: the backend exists so the ElevenLabs API key never reaches the browser — that is the entire reason for the relay.
2. `@app.websocket("/ws/transcribe")` handler:
   - `await websocket.accept()`.
   - If `ELEVENLABS_API_KEY` is missing: send `{"message_type": "backend_error", "error": "Server is missing ELEVENLABS_API_KEY. Add it to .env and restart."}` to the browser, close, return — never dial ElevenLabs.
3. Open the upstream connection inside `async with` (guaranteed closed on handler exit):
   ```python
   UPSTREAM = "wss://api.elevenlabs.io/v1/speech-to-text/realtime?audio_format=pcm_16000&commit_strategy=vad"
   async with websockets.connect(UPSTREAM, additional_headers={"xi-api-key": ELEVENLABS_API_KEY}) as upstream:
   ```
   Note the hard coupling: `audio_format=pcm_16000` in this URL MUST match what the frontend sends (PCM16 @ 16kHz). Add a comment saying so.
4. Wrap `websockets.connect` in try/except. On ANY connection exception (bad key, DNS, network): send one frame `{"message_type": "backend_error", "error": f"Couldn't connect to ElevenLabs Scribe Realtime: {e}"}` to the browser, then close.
5. Spawn two concurrent asyncio tasks:
   - `browser_to_upstream()`: loop `await websocket.receive_text()` → `await upstream.send(msg)`. Forward VERBATIM — no parsing, no transformation, no queue, no buffer. Pure pass-through.
   - `upstream_to_browser()`: loop `async for msg in upstream` → `await websocket.send_text(msg)`. Also verbatim. Additionally do a best-effort `json.loads` ONLY to log the `message_type` per event (`logger.info`) — never to modify the frame.
6. `await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)` — the moment either direction ends, cancel the other task.
7. `finally:` always close the browser WebSocket and log `"/ws/transcribe session ended"`.
8. Note in comments: `/ws/transcribe` has no auth — acceptable for a local single-user tool, NOT for multi-user deployment.

### STEP 4 — Display the live transcript (frontend)
`ws.onmessage` → `handleScribeMessage(msg)`. Wrap `JSON.parse` in try/catch: non-JSON → `console.log` and drop silently, no user-facing effect.
Switch on `msg.message_type` — handle ALL of these:
- `session_started` → status "listening…"
- `partial_transcript` → read `msg.text`; show/replace ONE italic "in progress" line. Each new partial replaces the previous.
- `committed_transcript` AND `committed_transcript_with_timestamps` → treat identically: read `msg.text`, append as a PERMANENT line in the transcript list, clear the italic partial line, and push the line into the session's `transcripts.lines` array in IndexedDB (so committed text survives page reload). **Per PART A3: also forward this line into the existing `/ws/lecture` pipeline.**
- Terminal error types — every one of: `backend_error`, `auth_error`, `quota_exceeded`, `rate_limited`, `invalid_request`, `input_error`, `session_time_limit_exceeded` → expected shape `{"message_type": "...", "error": "..."}`; show `msg.error` in a red error banner and call `stopRecording()`.
- Unknown `message_type` → `console.log` no-op default case. No user-facing error.

### STEP 5 — On stop: upload the final transcript to cloud storage
1. `stopRecording()`: set `isRecording = false`, `processorNode.disconnect()`, `sourceNode.disconnect()`, `audioCtx.close()`, stop every `MediaStreamTrack`, close the WebSocket with code `1000`, reason `"user stopped"`.
2. Mark the session `status: "done"` in IndexedDB.
3. `POST /api/transcript` with:
   ```json
   {
     "session_id": "<uuid>",
     "started_at": "<ISO timestamp>",
     "ended_at": "<ISO timestamp>",
     "lines": ["first committed line", "second committed line"]
   }
   ```
4. Backend `POST /api/transcript`: validate body (pydantic model), call `save_to_cloud(data)` — implement as a placeholder that writes JSON to `./storage/<session_id>.json` with a clear `# TODO: replace with S3/GCS/Azure upload` comment. Respond `{"ok": true, "storage_key": "<path>"}`.
5. On success: mark session `status: "uploaded"`, delete its chunks from IndexedDB.
6. On failure: keep everything in IndexedDB, show a "Retry upload" button. On every page load, check for sessions with `status: "done"` and offer re-upload.

### STEP 6 — Reconnection (REQUIRED)
1. `ws.onclose` while `isRecording === true` (i.e., not a deliberate stop): show the close reason ("Transcription connection closed unexpectedly" + `event.reason` if present), then reconnect with exponential backoff — start 1000ms, double each attempt, cap 10000ms, reset to 1000ms on success.
2. While disconnected, capture continues; chunks accumulate in IndexedDB (Step 2.5).
3. After reconnect: replay unsent chunks in `seq` order, then resume live. This starts a brand-new Scribe session (Scribe has no session resume), so text near the drop may be re-transcribed — acceptable; note it in a comment.
4. On `session_time_limit_exceeded`: instead of just stopping, automatically close and reopen the WebSocket (new Scribe session) and continue recording seamlessly.
5. Show connection status at all times: 🟢 connected / 🟡 reconnecting (attempt N) / 🔴 stopped.

### LATENCY EXPECTATION (for comments/README)
Speech → partial text on screen ≈ one buffer period (~256ms) + browser→backend hop + backend→ElevenLabs hop + Scribe processing time. No client-side batching delay. Transcript lines are appended in arrival order; no timecode alignment (the `_with_timestamps` variant's timestamp payload is intentionally ignored).

### RULES
- Per PART A, the exact file list is adapted: edit `frontend/index.html`, `frontend/app.js`, `backend/main.py`, plus add `backend/services/transcript_storage.py` (and optionally `backend/services/scribe_relay.py`). Do not create a parallel `static/index.html` or a second `main.py`.
- `requirements.txt`: `fastapi>=0.115`, `uvicorn[standard]>=0.32`, `websockets>=15.0`, `python-dotenv>=1.0`, `python-multipart>=0.0.12` (verify current versions already satisfy this; bump only if not).
- `.env.example` must list `ELEVENLABS_API_KEY=` (already present) and only keys actually used — keep it in sync with the code.
- Comment generously — a junior developer will read this.
- The relay stays "dumb": no audio parsing, no transcript logic on the WebSocket path. Transcript assembly happens 100% in the browser; the backend only relays, then receives the finished transcript on `/api/transcript`.
- Raw PCM16 only. Do NOT use MediaRecorder, Opus, or WebM anywhere.
- No features beyond this spec: no pause button, no audio playback, no audio file saving, no user auth.

### DEFINITION OF DONE
- [ ] Record → speak → italic partial text updates live and turns into permanent committed lines.
- [ ] Kill the backend mid-recording → 🟡 reconnecting with backoff; restart backend → transcription resumes automatically and no chunk captured during the outage is lost (verify in DevTools → Application → IndexedDB).
- [ ] Invalid API key → red error banner showing the `auth_error` from Scribe; recording stops cleanly.
- [ ] Missing API key in `.env` → immediate `backend_error` banner, ElevenLabs never dialed.
- [ ] Stop → transcript JSON appears in `./storage/`; session marked "uploaded"; its chunks deleted from IndexedDB.
- [ ] Reload mid-session → committed lines still present (loaded from IndexedDB).
- [ ] The ElevenLabs API key appears nowhere in frontend code, network responses, or the WebSocket URL.
