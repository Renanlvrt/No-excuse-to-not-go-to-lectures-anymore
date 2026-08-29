# Lecture → Living Mind-Map

Speak through a lecture (or type/paste text) → the concepts worth
diagramming grow into an interactive mind-map, live: color-coded flip-cards,
physics-based layout, per-concept AI Q&A, animated step-by-step process
walkthroughs, and on-demand illustrative images. See `SUCCESS_CRITERIA.md`
for the full objective checklist and what's actually been verified.

## Quick start
```powershell
.\start.ps1
```
Then open **http://localhost:8010/static/index.html** (any modern browser -
transcription is ElevenLabs Scribe server-side, not the Chrome-only Web
Speech API; `GEMINI_API_KEY` and `ELEVENLABS_API_KEY` live in `.env`).

Click **▶ Start listening** and talk. Concepts accumulate on a pannable/
zoomable canvas roughly every ~20s (or hit **⚡ Generate diagram now**).
Click any card to flip it and see its definition, ask it a follow-up
question, or generate an illustrative image. Cards tagged as a multi-step
process get a **▶ Play** button that animates through their steps.

**No mic, or recognition isn't picking anything up?** Type/paste lecture
text into the box under the transcript — same pipeline, fully verified path.

## Transcription: ElevenLabs Scribe realtime
The mic is captured as PCM16 @16kHz in the browser and streamed over the
app's own websocket to the backend, which relays it to ElevenLabs' realtime
STT websocket (`scribe_v2_realtime`, VAD commit strategy) — so the API key
never reaches the browser. `partial_transcript` events render as live
interim text; `committed_transcript` events append to the server-side
transcript that feeds the Gemini extraction loop.

This is the *only* transcription path — the browser's own Web Speech API is
never used, so every laptop gets the same accuracy. On a machine with no
`ELEVENLABS_API_KEY` in `.env`, the backend reports `has_key: false` and the
UI shows a key box: paste a key there and it's kept in that browser's
`localStorage`, sent to *this* backend on every (re)connect, and used for
that connection only. Nothing to install on a friend's laptop beyond the app.

## How a concept becomes a card
1. The transcript is sent to Gemini along with the concept map already built
   so far (`backend/services/diagram.py`) — the model returns the *complete*
   updated graph, reusing ids for anything already covered so nothing is
   ever silently dropped or redefined
2. Each node carries a `mode` the model itself chooses per concept -
   `definition` (a static idea), `steps` (a process worth animating), or
   `interactive` (a concept best learned by poking at it — feeds Phase 2)
3. The frontend (`frontend/app.js`) merges the graph into a running
   `nodeState`, lays it out with a `d3-force` physics simulation plus a
   custom rectangle-collision force (guarantees no card overlap), and
   renders each node as a flip-card

## What's verified vs. what isn't

See `SUCCESS_CRITERIA.md` for the full, itemized, automated-verification
checklist (10/10 core categories, all driven through the real running app
with Playwright, not just eyeballed). Two honest gaps:

- **Live mic → ElevenLabs with a real speaker**: the full backend path was
  verified with synthesized audio (partial → committed → transcript), and
  real audio reaching the browser was verified directly (measured signal via
  getUserMedia), but nobody has spoken into it under automation. The manual
  text box is the proven fallback if it misbehaves.
- **A successful on-demand image render**: the mechanism (single call per
  click, never automatic, graceful failure with per-card recovery) is fully
  verified — including a real bug found and fixed where a failed request
  left a card's button stuck on "Generating…" forever. A successful render
  itself wasn't confirmed today because free-tier quota for all 3 image
  model variants was exhausted by testing. Same code path either way, so
  this is a low-risk gap — re-check once quota resets (midnight Pacific).

## Setup (if not using start.ps1)
```
pip install -r requirements.txt
copy .env.example .env   # fill in GEMINI_API_KEY (already done in .env)
uvicorn backend.main:app --port 8010
```

## Known issues / things to know
- **Corporate/Avast SSL interception**: this machine's Avast antivirus
  MITMs HTTPS for scanning. Fixed via `pip-system-certs` (trusts the Windows
  cert store), wired into `backend/main.py`.
- **Every Gemini call runs inline on the main thread, never in a background
  thread**: `asyncio.to_thread` hangs indefinitely here — the cert-trust
  patch's Windows cert-store lookup isn't thread-safe on this machine. Each
  call blocks the event loop for a couple seconds; fine for one runner,
  would need real fixing (e.g. a subprocess-based worker, since threads are
  the one thing confirmed unsafe here) for multiple concurrent users.
- **Multiple Gemini model names = separate free-tier quota pools.**
  `backend/services/llm.py` tries a fallback chain
  (`gemini-flash-lite-latest` → `gemini-flash-latest` →
  `gemini-3.1-flash-lite` → `gemini-3.6-flash`) so one model running out
  mid-demo doesn't take the app down — this saved a live demo once already.
  `backend/services/imagegen.py` has its own chain for image-capable models.
- **20s extraction interval** (`EXTRACTION_INTERVAL_SECONDS` in
  `backend/main.py`): a conservative guess balancing "feels live" against
  free-tier rate limits, not a precisely measured number. Backs off
  automatically for ~2min after any error.
- Text model in use: `gemini-3.6-flash` (chain above as fallback). Image
  models: `gemini-3.1-flash-image` (chain, see `imagegen.py`) — Google's
  model lineup moves fast; expect to need updates as models get retired.

## Sponsors (RUN/HACK, London, Aug 29 2026)
- **Google Gemini** — the actual LLM in use, powers everything
- **ElevenLabs** — Scribe v2 realtime is now the transcription engine
  (`backend/services/transcribe.py`); the browser's Web Speech API is unused.
- Tavily — no working API key; not wired in.
- ⚠️ RUN/HACK's official sponsor list wasn't published as of building this —
  ElevenLabs/Tavily were guesses based on the hackathon name pattern, not
  confirmed sponsors.

## Architecture
```
frontend/index.html    Markup shell, loads d3 (CDN) + style.css + app.js
frontend/style.css      Flip-card 3D, canvas/viewport, dark-mode tokens
frontend/app.js         Everything client-side: WebSocket + reconnect,
                         speech recognition, d3-force physics + custom
                         rect-collision, card render/flip/play/ask/image,
                         pan/zoom (pointer events, mouse+touch+pinch)
backend/main.py          FastAPI + WebSocket: per-connection accumulated
                         graph state, timer/force-triggered extraction,
                         `ask` / `generate_image` message handling
backend/services/
  llm.py                 Shared Gemini-call-with-model-fallback helper
  diagram.py              Stateful graph extraction (feeds prior graph back
                          into the prompt; merges + never-delete safety net)
  qa.py                   Per-node follow-up Q&A
  imagegen.py              On-demand image generation, its own model chain
  transcribe.py            ElevenLabs Scribe: batch helper + realtime session
  enrich.py                (unused - Tavily search, no key found)
```

## Phase 2 (not started)
A "🧩 Create interactive animation" button per card: Gemini generates a
self-contained HTML/JS widget (e.g. a Turing machine you can feed input to)
rendered in a sandboxed `<iframe sandbox="allow-scripts">` (no
`allow-same-origin`) with a defense-in-depth CSP blocking network egress.
Researched and scoped (see `SUCCESS_CRITERIA.md` #11) but not yet built.
