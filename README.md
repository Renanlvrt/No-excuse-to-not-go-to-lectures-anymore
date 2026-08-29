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
Then open **http://localhost:8010/static/index.html** — **Chrome preferred**:
the mic path is Chrome's own Web Speech API, with ElevenLabs Scribe as the
fallback on browsers that don't have it. `GEMINI_API_KEY` and
`ELEVENLABS_API_KEY` live in `.env`.

Click **▶ Start listening** and talk. Concepts accumulate on a pannable/
zoomable canvas roughly every ~15s (or hit **⚡ Generate diagram now**).
Click any card to flip it and see its definition, ask it a follow-up
question, or generate an illustrative image. Cards tagged as a multi-step
process get a **▶ Play** button that animates through their steps.

**No mic, or recognition isn't picking anything up?** Type/paste lecture
text into the box under the transcript — same pipeline, fully verified path.

## Transcription: two paths
**Mic → Chrome Web Speech API (the default).** Chrome transcribes on-device
and `frontend/app.js` posts each final sentence as a `speech_segment`
websocket message and interim words as `speech_partial`. The backend feeds
`speech_segment` into exactly the same path as an ElevenLabs committed
segment (transcript append + the level-intent regex), so no feature cares
which engine produced the text. Costs no ElevenLabs quota and has near-zero
latency.

**ElevenLabs Scribe realtime** (`backend/services/transcribe.py`) is still
wired up and used for two things: the **🔊 Listen to a tab** button (Web
Speech cannot consume a captured `MediaStream`, and tab capture is the only
thing that works when the mic can't hear the machine's own speakers), and as
the **mic fallback** on any browser without the Web Speech API. Audio is
captured as PCM16 @16kHz and streamed over the app's own websocket to the
backend, which relays it to `scribe_v2_realtime` (VAD commit strategy) — the
API key never reaches the browser. `partial_transcript` events render as live
interim text; `committed_transcript` events append to the server-side
transcript that feeds the Gemini extraction loop.

On a machine with no `ELEVENLABS_API_KEY` in `.env`, the backend reports
`has_key: false`; on a browser with no Web Speech API the UI then shows a key
box — paste a key there and it's kept in that browser's `localStorage`, sent
to *this* backend on every (re)connect, and used for that connection only.

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
  `backend/services/llm.py` tries a fallback chain so one model running out
  mid-demo doesn't take the app down — this saved a live demo once already.
  The chain is ordered **for latency, not just quota**:
  `gemini-3.1-flash-lite` → `gemini-flash-lite-latest` → `gemini-3.6-flash` →
  `gemini-flash-latest`. `gemini-3.1-flash-lite` answers in ~2s, the `-latest`
  aliases take 10-18s, and `gemini-flash-latest` is currently 429ing; since
  every call blocks the event loop, the fastest healthy model goes first.
  `backend/services/imagegen.py` has its own chain for image-capable models.
- **Extraction is capped at 2 attempts × 10s** (`max_attempts=2` in
  `backend/services/diagram.py`), so walking the whole chain past a slow model
  can't stall the event loop.
- **Extraction cadence and quota guards** (`backend/main.py`):
  `EXTRACTION_INTERVAL_SECONDS = 12` in steady state, a hard wall-clock floor
  of `MIN_SECONDS_BETWEEN_CALLS = 7` between any two calls (an explicit
  "generate now" click included), a fast empty-map mode capped at
  `FAST_MODE_MAX_ATTEMPTS = 3` attempts, and a `MIN_NEW_CHARS = 80` gate that
  measures committed + typed text only (never the mutating partial). After an
  error it backs off 15s, doubling to 90s. Measured on a real 2-minute
  lecture-pace run: first cards at ~13.6s, then a new extraction every ~15s,
  3.8 Gemini calls/min, 0 errors, 10 nodes.
- Text model tried first: `gemini-3.1-flash-lite` (chain above as fallback). Image
  models: `gemini-3.1-flash-image` (chain, see `imagegen.py`) — Google's
  model lineup moves fast; expect to need updates as models get retired.

## Sponsors (RUN/HACK, London, Aug 29 2026)
- **Google Gemini** — the actual LLM in use, powers everything
- **ElevenLabs** — Scribe v2 realtime transcription for tab audio and as the
  mic fallback (`backend/services/transcribe.py`), plus per-level TTS
  (`backend/services/tts.py`). Video generation is 402-blocked on free tier.
- Tavily — no working API key; not wired in.
- ⚠️ RUN/HACK's official sponsor list wasn't published as of building this —
  ElevenLabs/Tavily were guesses based on the hackathon name pattern, not
  confirmed sponsors.

## Architecture
```
frontend/index.html    Markup shell, loads d3 (CDN) + style.css + app.js
frontend/style.css      Flip-card 3D, canvas/viewport, dark-mode tokens
frontend/app.js         Everything client-side: WebSocket + reconnect,
                         Web Speech mic + Scribe audio pump, d3-force physics + custom
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
