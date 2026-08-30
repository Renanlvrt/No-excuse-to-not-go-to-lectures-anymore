# why.md — Live Listening + Real-Time Transcript

Written for an agent with zero prior context on this repo. Every claim
below is backed by a specific file/line. Anything the code does not
actually show is marked **UNKNOWN / verify**, not guessed.

---

## 1. Purpose

This feature turns spoken (or typed) lecture content into a running text
transcript that feeds a live concept-graph extraction pipeline. Its job
is narrowly: **get words into `state["transcript"]` on the backend, as a
plain string, as continuously as possible**, so a separate periodic job
(`extraction_loop` in `backend/main.py:225`) can turn that text into a
mind-map. It is not a general audio-recording or audio-transcription
service — see §6, this matters.

## 2. Overview

```
 mic (browser)
   │
   ▼
 window.SpeechRecognition   <-- Chrome's built-in, cloud-backed engine
 (frontend/app.js:905 startRecognition)
   │  onresult fires only for FINAL results (interimResults = false)
   ▼
 fullTranscript (JS string, browser memory only, app.js:35)
   │  on every final result:
   ▼
 ws.send(JSON.stringify({ text: fullTranscript + " " + manualInput.value }))
 (app.js:919)
   │  WebSocket, one connection per browser tab
   ▼
 backend/main.py: /ws/lecture  (lecture_ws, main.py:44)
   receive_loop() default branch (main.py:205-208):
     state["transcript"] = msg["text"]      # full string, REPLACED each time
   │
   │  (separate, independent timer, every 20s or on forced flag)
   ▼
 extraction_loop() -> extract_flowchart(transcript, state["graph"])
 (main.py:210-224, calls backend/services/diagram.py)
   │
   ▼
 ws.send({"type": "diagram", "data": graph})  -> frontend renders mind-map
```

**Key correction vs. a typical "live transcription" system**: there is
no STT happening on the backend, no audio bytes ever leave the browser
tab, and no "partial" text is ever displayed or sent — see §3 and §5.

## 3. Capture

- API used: **`window.SpeechRecognition || window.webkitSpeechRecognition`**
  — the browser's native Web Speech API (`frontend/app.js:34`). This is
  **not** `MediaRecorder` or `AudioWorklet`; no raw audio buffer is ever
  touched by this app's code.
- Instantiation and config (`app.js:905-910`, `startRecognition()`):
  ```js
  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = "en-US";
  ```
  - `continuous: true` — engine keeps listening across multiple
    utterances instead of stopping after one phrase.
  - `interimResults: false` — **no partial/interim results are ever
    delivered to `onresult`.** Only finalized utterances arrive. There is
    no "live partial text" in this codebase's actual behavior, despite
    that being a common pattern elsewhere.
  - `lang: "en-US"` hardcoded, not configurable via UI or env var.
- Sample rate / audio format / chunk interval: **UNKNOWN / verify** —
  these are internal to the browser's Web Speech engine and are never
  set, read, or referenced anywhere in this codebase. There is no
  chunking logic in this app; chunking (if any) happens inside Chrome's
  own implementation, out of reach of this code.
- Start/stop:
  - Start: `startBtn.onclick` (`app.js:748-761`) sets `listening = true`,
    calls `startRecognition()` if `SpeechRecognition` exists in the
    browser, else shows a toast ("Speech recognition not supported in
    this browser...", `app.js:761`).
  - Stop: same handler, `else` branch (`app.js:749-755`): sets
    `listening = false`, calls `recognitionInstance.stop()`.
  - Auto-restart: `recognition.onend` (`app.js:939`) calls
    `recognition.start()` again **iff `listening` is still true** — this
    is how "continuous" listening survives the engine's own periodic
    internal restarts. (This is also what caused a duplicate-toast bug
    on network errors, fixed in this repo by adding
    `stopListeningDueToMicError()`, `app.js:905-911`, which sets
    `listening = false` before the error toast so `onend` does not loop.)
  - Permissions: **never explicitly requested by this code.** Calling
    `recognition.start()` implicitly triggers the browser's mic
    permission prompt the first time; this app only reacts to the result
    via `onerror` (`event.error === "not-allowed" || "service-not-allowed"`,
    `app.js:928-931`). There is no `navigator.mediaDevices.getUserMedia`
    call anywhere in this codebase.

## 4. Transport

- Protocol: single WebSocket per tab, opened in `connect()`
  (`app.js:770-780`):
  ```js
  ws = new WebSocket(`ws://${location.host}/ws/lecture`);
  ```
- Backend endpoint: `@app.websocket("/ws/lecture")` → `lecture_ws`
  (`backend/main.py:44-45`).
- Message shapes actually sent by the frontend (all JSON, all sent with
  plain `ws.send(JSON.stringify(...))`, no envelope/versioning):
  - Transcript update (no `type` field — this is the "default" case the
    backend matches on absence of a recognized `type`):
    `{"text": "<cumulative fullTranscript + ' ' + manualInput.value, trimmed>"}`
    — sent from three call sites: on every final speech result
    (`app.js:919`), on every manual textarea `input` event (`app.js:764-768`),
    and once on `ws.onopen` if there's already buffered text
    (`app.js:778-779`).
  - Other message types on the same socket (unrelated to transcript
    capture, listed for completeness since they share the connection):
    `{"type":"ask", ...}`, `{"type":"generate_image", ...}`,
    `{"type":"generate_widget", ...}`, `{"type":"generate_video", ...}`,
    `{"type":"generate_check", ...}`, `{"type":"generate_quiz"}`,
    `{"type":"generate_summary"}` (call sites: `app.js:388,579,655,680,729,1043,1062`).
  - A `"force": true` field may accompany a transcript update (not shown
    at the three send sites above as of this reading — **UNKNOWN /
    verify** whether any current UI path actually sets it) to make
    `backend/main.py:207-208` set `force_event`, which makes
    `extraction_loop` run immediately instead of waiting for the 20s
    timer (`main.py:227-234`).
- Backend receive handling: `receive_loop()` (`main.py:133-208`) is an
  infinite `await ws.receive_json()` loop; the default (no matching
  `msg_type`) branch does:
  ```python
  state["transcript"] = msg.get("text", state["transcript"])
  ```
  i.e. **each message replaces the whole transcript string** — the
  frontend is responsible for always sending the full cumulative text,
  not a delta. Backend does no diffing.
- Server → client transcript-pipeline messages: `{"type":"diagram","data":<graph>}`
  or `{"type":"empty"}` (`main.py:219-222`), sent only from
  `run_extraction`, not from the transcript-receiving code path itself
  (i.e. sending a transcript update does not get an immediate ack —
  the diagram update, if any, arrives asynchronously up to
  `EXTRACTION_INTERVAL_SECONDS` later).

## 5. Transcription

- Engine: **the browser's own Web Speech API implementation** (in
  Chrome, backed by Google's cloud speech service — this is why a
  `"network"` error surfaces when that service is unreachable,
  `app.js:932`). This is entirely client-side; **the backend has no STT
  engine wired in.**
- Config: none beyond §3 (`continuous`, `interimResults: false`, `lang`).
  No model name, no sample rate, no punctuation/profanity flags — the
  Web Speech API in this app is used with defaults only.
- Partial vs. final: **there are no partial results in this app's
  behavior** — `interimResults: false` means `onresult` (`app.js:912-923`)
  only ever receives `event.results[i].isFinal === true` entries in
  practice (the code does check `.isFinal` defensively, but the engine
  is configured to never emit non-final ones). Each final result's
  transcript is appended to `fullTranscript` with a leading space
  (`app.js:915`), the transcript `<div>` is updated and scrolled
  (`app.js:916-917`), and immediately pushed over the WebSocket if open
  (`app.js:918-919`).
- **A second, unused STT path exists in the repo**:
  `backend/services/transcribe.py` wraps ElevenLabs' Scribe STT
  (`model_id="scribe_v1"`, via `elevenlabs.client.ElevenLabs`) in a
  function `transcribe_chunk(audio_bytes) -> str`. It is **never
  imported by `backend/main.py`** (confirmed: no `transcribe` import
  anywhere in `main.py`) and is explicitly documented as dead code in
  `AI_HANDOFF/03_DECISIONS.md:27,41-47`: *"kept from an earlier
  exploration phase... browser-native Web Speech API was used for
  transcription instead — free, zero backend involvement."* Do not use
  this file as evidence of how transcription actually works in this app.

## 6. Simultaneity

**This is the key finding: there is no simultaneous save-and-transcribe
of one audio stream in this codebase.** There is no tee, no dual
consumer, no `MediaRecorder` running alongside `SpeechRecognition`.
Concretely:
- No code path captures or retains raw audio bytes at all — search of
  `frontend/app.js` and `backend/` turns up no `MediaRecorder`, no
  `getUserMedia`, no audio `Blob`/`ArrayBuffer` handling.
- The **only** artifact that leaves the browser tab is recognized
  **text** (`{"text": "..."}` over the WebSocket, §4) — the audio itself
  is consumed entirely inside the browser's Web Speech engine and
  discarded there.
- So "the same audio stream is both saved as a recording and
  transcribed live" **does not happen in this system as built.** If you
  are asked to rebuild "the same system," rebuild the text-out pipeline
  described in §2–§5; do not invent a recording path that isn't here.
- If a real dual-consumer design is later wanted (e.g. save a `.wav` +
  stream to an STT engine simultaneously), that would require actually
  wiring up `MediaRecorder` (for the save side) reading from the same
  `MediaStream` returned by `getUserMedia`, alongside sending chunks to
  something like `transcribe_chunk` in `backend/services/transcribe.py`
  — but that whole path is unbuilt today (UNKNOWN / verify if it's
  wanted; it isn't present, per above).

## 7. Storage

- **Transcript**: never persisted anywhere. `state["transcript"]`
  (`main.py:47-63`) lives only in the closure of one `lecture_ws`
  WebSocket connection handler, in server process memory. It is
  reinitialized to `""` on every new connection (`main.py:47-63`) and
  is lost on disconnect/server restart. The frontend's `fullTranscript`
  (`app.js:35`) similarly lives only in the tab's JS memory and is lost
  on refresh.
- **Audio**: never captured, so nothing to store (§6).
- **What *is* persisted**: per-concept generated artifacts (images,
  widgets, videos), cached to disk as JSON files under `data/` via
  `backend/services/cache.py` (`CACHE_DIR = .../data`, `cache.py:17-18`,
  `get_cached`/`set_cached`, keyed by a slugified concept label,
  `cache.py:23-24,41-50`). This is a concept-artifact cache, **not** a
  transcript/audio store.
- **On "Stop" (`startBtn` click while listening)**: only stops the
  recognition engine (`recognitionInstance.stop()`, `app.js:753`) and
  flips UI state; does not touch the transcript, does not save
  anything, does not close the WebSocket (`app.js:748-756` — WS stays
  connected so ask/quiz/wrap-up still work per the comment at
  `app.js:37-39`).
- **On "Wrap-up"**: `generate_summary` is requested over the same
  WebSocket (`app.js:1062`) and the backend runs
  `generate_summary(state["graph"])` (`main.py:194-203`) — this
  summarizes the **concept graph**, not the raw transcript, and the
  result is sent back as `{"type":"summary", "summary": ...}` and
  rendered in an overlay (`renderWrapup`, referenced `app.js:881`); it is
  not written to disk anywhere in `backend/services/summarygen.py`
  (verified: no file writes in that module).

## 8. Errors

- **Mic/recognition errors** (`recognition.onerror`, `app.js:925-937`):
  - `"no-speech"` → ignored, no toast, recognition keeps running.
  - `"not-allowed"` / `"service-not-allowed"` → calls
    `stopListeningDueToMicError(...)` (`app.js:905-911`): sets
    `listening = false`, resets the Start/Stop button, stops the
    recognition instance, shows one toast. This prevents `onend`
    (`app.js:939`) from auto-restarting into a repeat error.
  - `"network"` → same `stopListeningDueToMicError(...)` handling (fixed
    in this repo to stop the loop rather than retrying every restart).
  - any other error → shows a toast (`app.js:936`) but does **not** stop
    `listening`, so `onend` will still auto-restart recognition.
  - If `SpeechRecognition` doesn't exist on `window` at all → toast at
    `app.js:761`, no recognition attempted.
- **WebSocket errors/drops** (`app.js:892-902`):
  - `ws.onclose` always schedules a reconnect via
    `setTimeout(connect, reconnectDelay)`, **regardless of `listening`**
    — the comment at `app.js:894-896` explains this is intentional
    since the socket also powers ask/quiz/simulations/wrap-up, not just
    the mic pipeline.
  - Exponential backoff: `reconnectDelay = Math.min(reconnectDelay * 2, 10000)`
    (`app.js:899`), reset to `1000` on successful reconnect
    (`app.js:777`).
  - `ws.onerror` just sets a status string ("connection error -
    retrying...", `app.js:902`); the actual retry logic lives in
    `onclose`, since a WS error is normally followed by a close event.
  - On reconnect, the frontend proactively resends whatever transcript
    it currently has (`app.js:778-779`) so the backend's fresh, empty
    `state["transcript"]` (re-created per connection, `main.py:47-63`)
    catches back up — this is the only recovery mechanism for the
    backend having lost transcript state on a dropped connection.
- **Backend extraction errors** (`run_extraction`, `main.py:210-223`):
  wraps the Gemini call in `try/except`, sends
  `{"type":"error","message":...}` on failure, and
  `extraction_loop` (`main.py:225-255`) applies a backoff of up to
  `MAX_BACKOFF_SKIPS = 6` cycles (`main.py:32`) before trying again.

## 9. Rebuild steps

Minimal steps to reproduce this exact system (text-out pipeline, not a
recording pipeline — see §6) in a different stack:

1. **Frontend capture**: instantiate the platform's native/browser
   speech-recognition API if available (this app used
   `webkitSpeechRecognition`/`SpeechRecognition` — no server-side STT).
   Configure for continuous listening, finals-only:
   ```js
   const r = new SpeechRecognition();
   r.continuous = true;
   r.interimResults = false;
   r.lang = "en-US";
   r.onresult = (e) => {
     for (i = e.resultIndex; i < e.results.length; i++)
       if (e.results[i].isFinal) transcript += " " + e.results[i][0].transcript;
     send({ text: transcript });
   };
   r.onerror = (e) => {
     if (e.error === "no-speech") return;
     stopAndToast(e.error); // sets listening=false BEFORE onend fires
   };
   r.onend = () => { if (listening) r.start(); };
   ```
2. **Transport**: open one WebSocket per client session to a single
   endpoint (this app: `/ws/lecture`). On every recognized final
   utterance (and on every manual text edit, if you support a
   type-instead-of-speak fallback), send the **full cumulative
   transcript so far** as `{"text": "<string>"}` — not a delta.
3. **Backend receive loop**: maintain one in-memory `transcript` string
   per connection. On each incoming message with a `text` field,
   overwrite it: `state.transcript = msg.text`.
4. **Periodic extraction**: run a separate async loop per connection on
   a fixed interval (this app: 20s, `EXTRACTION_INTERVAL_SECONDS`,
   `main.py:28`) that, if the transcript changed since last pass, sends
   it to an LLM to extract structured data (here: a concept graph via
   `extract_flowchart`, `backend/services/diagram.py`), then pushes the
   result back over the same socket. Support a "force" flag/event to
   let a user action skip the wait.
5. **Backoff on extraction failure**: on an exception from the
   LLM call, skip N subsequent cycles before retrying (this app: up to
   6, `MAX_BACKOFF_SKIPS`) instead of retrying every interval.
6. **Reconnect logic**: on socket close, always attempt reconnect with
   exponential backoff (capped, e.g. 1s → 10s here), regardless of
   whether the user is actively "listening" — other features may
   depend on the same socket. On reconnect, resend the client's current
   transcript so server-side state (which is per-connection, not
   persisted) catches up.
7. **Do not build a recording path unless explicitly asked** — this
   system, as it stands, never captures or stores raw audio. If a
   dual-consumer (save + live-transcribe) design is actually wanted,
   that's new work: split the `MediaStream` from `getUserMedia` between
   a `MediaRecorder` (writing to storage) and a chunked upload to a
   server-side STT engine (e.g. the unused `ElevenLabs scribe_v1`
   wrapper already sitting in `backend/services/transcribe.py`,
   `transcribe_chunk(audio_bytes) -> str`) — but treat that as new
   design work, not a description of the current system.

## 10. Dependencies

- **Frontend**: no package manager, no build step, no bundler — one
  `<script>` tag for D3 (per `AI_HANDOFF/03_DECISIONS.md:107-110`) plus
  plain `app.js`. Speech recognition uses the browser's built-in
  `SpeechRecognition`/`webkitSpeechRecognition` global — no external JS
  library.
- **Backend** (from `requirements.txt`): `fastapi`, `uvicorn[standard]`
  (ASGI server + WebSocket support), `websockets`, `python-multipart`,
  `requests`, `httpx`, `python-dotenv`, `truststore`, `pip-system-certs`
  (Windows cert-store trust shim, see `main.py:4`),
  `google-generativeai` (used by `backend/services/llm.py` for the
  concept-graph extraction LLM — **not** for speech; confirmed no audio
  is ever sent to Gemini), `elevenlabs` (only actually referenced by the
  **unused** `transcribe.py` and, separately, by `videogen.py` for
  video generation — not for the live transcript path), `tavily-python`
  (only used by the unused `enrich.py`).
- **Required env vars** (names only, from `.env.example` and code):
  - `ANTHROPIC_API_KEY` — present in `.env.example`; **UNKNOWN / verify**
    where this is consumed (no `ANTHROPIC` reference found in
    `backend/services/llm.py`, which uses `google.generativeai`
    instead — this key may be vestigial or used by tooling outside this
    reading's scope).
  - `ELEVENLABS_API_KEY` — read in `backend/main.py:20` (gates
    `generate_video`) and in `backend/services/transcribe.py:5` (unused
    path).
  - `TAVILY_API_KEY` — only referenced by the unused `enrich.py`
    (**UNKNOWN / verify** exact usage, out of scope for this feature).
  - `GEMINI_API_KEY` — read in `backend/services/llm.py:11`
    (`genai.configure(api_key=os.getenv("GEMINI_API_KEY"), transport="rest")`),
    required for the extraction LLM calls that actually power this
    feature's downstream graph. **Not listed in `.env.example`** even
    though `start.ps1`'s own startup warning tells the user to set it
    (`start.ps1:14-15`) — `.env.example` is out of date relative to the
    code.
- No env var directly configures the speech-recognition capture path
  itself (§3) — that path has no backend dependency at all.
