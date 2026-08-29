# Handover — Lecture → Living Mind-Map

Read `CLAUDE.md` first; this file is the delta on top of it. Submissions close
**18:00** London, pitches **19:00**. Workflow is push-straight-to-`main`, no PR
gate. `git pull --rebase` before you push.

Head of `main` as this was written: `a78308b`. All three bugs the previous
handover listed as open are **fixed and landed** — do not re-fix them.

## What the app is

Live lecture speech → transcript → Gemini extracts concepts every ~15s → a
growing, physics-laid-out mind-map of concept cards. Click a card for a side
panel: definition, animated step walkthrough, per-concept Q&A, on-demand
image, generated interactive widget, generated video, quiz. FastAPI + one
WebSocket (`/ws/lecture`), vanilla JS + d3-force, no build step.

## Fixed since the last handover

**1. Extraction loop no longer burns quota** (`extraction_loop()` in
`backend/main.py`, commits `9fdb161` + `a78308b`). Four changes:

- A wall-clock throttle, `MIN_SECONDS_BETWEEN_CALLS = 7`, is a hard floor
  between two Gemini extractions — honoured by the fast empty-map cadence and
  by an explicit "generate now" click, so clicking it five times costs one call.
- The fast empty-map mode is capped at `FAST_MODE_MAX_ATTEMPTS = 3` attempts
  instead of running "until nodes exist". An extraction that legitimately
  returns nothing ("so, um, let's get started") can no longer pin the loop in
  3s mode forever.
- The "has anything new been said?" gate measures **committed + typed text
  only** (`stable`), never the mutating `partial`. Gemini still *sees* the
  partial, so the map reacts mid-sentence, but a rewritten interim result no
  longer reads as new speech and buys a call (`MIN_NEW_CHARS = 80`).
- Backoff after an error is time-based: `BACKOFF_START_SECONDS = 15`, doubling
  to `BACKOFF_MAX_SECONDS = 90`. It was counted in loop ticks, which silently
  shrank it to ~18s at the fast cadence.

Measured on a real 2-minute lecture-pace run: first cards at **~13.6s**, then a
new extraction every **~15s**, **3.8 Gemini calls/min**, **0 errors**, 10 nodes.

**2. Spoken level commands no longer fire on the lecturer's own words**
(`backend/services/intent.py`, commit `4d20f19`): a match now needs an
*addressed command* — an imperative/request anchored at the start of the
sentence ("go deeper", "explain that simpler", "give me the proof") or an
explicit first/second-person complaint ("I don't get it", "you lost me").
Bare nouns like "proof" / "intuition" / "rigorous" no longer match, so "we go
deeper into this next week" is lecture and returns `None`.

**3. Level-3 audio cache no longer poisons itself** (`backend/services/tts.py`,
commit `425919a`): the mp3 filename now carries a 12-char sha256 of the
normalised text actually sent to ElevenLabs, alongside (slug, level). An early
speak click that voices the definition on the Rigour tab can no longer occupy
`{slug}_l3.mp3` forever; old-scheme files are simply never consulted.

## Transcription changed: Chrome Web Speech is the mic path again

Commit `9fdb161`. The microphone now goes through Chrome's own Web Speech API,
in-browser: `frontend/app.js` sends `speech_segment` (final) and
`speech_partial` (interim) websocket messages, and the backend routes
`speech_segment` through exactly the same `on_committed()` path (including the
level-intent regex) as an ElevenLabs committed segment. No ElevenLabs quota,
near-zero latency.

ElevenLabs Scribe realtime (`backend/services/transcribe.py`) is still used for:

- the **🔊 Listen to a tab** button — capturing a tab's audio, which Web Speech
  can't consume, and the only path that works when the mic can't hear the
  machine's own output;
- the **fallback** on any browser with no Web Speech API (then the key box
  shows, key kept in that browser's `localStorage`).

## LLM / quota

- Fallback chain in `backend/services/llm.py` was **reordered for latency**:
  `gemini-3.1-flash-lite` answers in ~2s while the `-latest` aliases take
  10–18s and `gemini-flash-latest` is currently 429ing. Order is now
  `gemini-3.1-flash-lite` → `gemini-flash-lite-latest` → `gemini-3.6-flash` →
  `gemini-flash-latest`.
- Extraction is capped at **2 attempts × 10s timeout**
  (`generate_with_fallback(..., timeout=10, max_attempts=2)` in `diagram.py`),
  so a slow model can't stall the event loop for the whole chain.
- Steady state is `EXTRACTION_INTERVAL_SECONDS = 12` plus the 7s floor and the
  80-new-chars gate — in practice ~4 calls/min against the ~10 RPM free cap.

## Hard constraints — these are not preferences

- **No new dependencies**, no frontend build step, vanilla JS only.
- **Never add threads.** `asyncio.to_thread` deadlocks on the demo machine
  (Windows cert-store lookup isn't thread-safe under Avast SSL interception).
  Every Gemini call is blocking on the single event loop. For genuinely async
  I/O copy `videogen.py`: `httpx` async client + `truststore`.
- LLM text is rendered with **`textContent`, never `innerHTML`**.
- **All text generation goes through `generate_with_fallback`** in `llm.py` —
  separate model names are separate quota pools, and this has saved a live demo
  already. Don't bypass it.
- Free-tier budget is tight and has been exhausted mid-demo before. Nothing
  automatic, nothing per-node-in-a-loop; cache by concept slug via
  `backend/services/cache.py`.
- `.env` is gitignored and holds `GEMINI_API_KEY` + `ELEVENLABS_API_KEY`. Never
  commit it, never invent placeholder keys.

## Known limitation

ElevenLabs **video** generation is 402-blocked on the free tier (verified).
TTS is not. Don't build anything on video.

## What's left

1. **No full end-to-end UI pass of every feature has been done yet** — click
   every button on a real run with real keys. If it doesn't run at 19:00,
   nothing else counts.
2. **No backup demo recording yet** (30–60s clip). It is the only defence
   against the mic, the Wi-Fi, or a quota failing on stage.
3. **Remaining TTS character quota is unknown**: the ElevenLabs key has no
   `user_read` scope, so the usage endpoint can't be queried.

## Pitch angle, for context on what to prioritise

The wedge is "make live attendance mechanically matter again": a companion
artifact that only exists because you were physically there, listening in real
time — not a note-taking tool you could point at a recording afterwards. Three
comprehension levels and voice control serve that story. Judge new work against
it. See `PITCH.md`.
