# Handover — Lecture → Living Mind-Map, RUN/HACK day, 16:15 London

Paste this whole file into a fresh chat before it touches anything.
Submissions close **18:00**, pitches **19:00**. Read `CLAUDE.md` in the repo
first; this file is the delta on top of it.

## Repo

`https://github.com/Renanlvrt/No-excuse-to-not-go-to-lectures-anymore`,
branch `main`, workflow is push-straight-to-main (no PR gate).

**`main` is stale: last commit `6439b4e`, 15:52.** Work exists on teammates'
laptops that has not been pushed. Before you write a single line: `git fetch
&& git log origin/main` and confirm you are on the real head. If someone
pushed since, re-read this file's "known bugs" section against the new code —
some of it may already be fixed.

## What the app is

Live lecture speech → ElevenLabs Scribe → Gemini extracts concepts every N
seconds → a growing, physics-laid-out mind-map of concept cards. Click a card
for a side panel: definition, animated step walkthrough, per-concept Q&A,
on-demand image, generated interactive widget, generated video, quiz.
FastAPI + one WebSocket (`/ws/lecture`), vanilla JS + d3-force, no build step.

## What landed today (all on main, all working)

1. **ElevenLabs Scribe realtime STT** replaced the browser's Web Speech API.
   Mic → our websocket → ElevenLabs, so the key never reaches the browser.
2. **Semantic Knowledge Map** — radial hierarchy layout replacing the old
   free-floating force layout.
3. **Three comprehension levels per concept.** L1 Intuition = the node's
   existing `analogy`, L2 Mechanism = its `definition`, L3 Rigour =
   `backend/services/explain.py`, the only one generated. L1/L2 and the
   topbar "whole map" selector are pure in-memory re-renders — zero API
   calls, by design, and it must stay that way. L3 is generated on explicit
   click only, cached by concept slug, and stored on the node so extraction
   merges preserve it.
4. **Voice-driven levels + per-level TTS.** Committed Scribe segments run
   through a local regex (`backend/services/intent.py`, no LLM call) so a
   spoken aside switches the selected card's level. Each level plays back in
   a different ElevenLabs voice (`backend/services/tts.py`), cached to
   `data/audio/`.
5. **Faster first diagram** — partial (uncommitted) transcript now feeds
   extraction, segments force-commit every 6s, extraction polls every 3s
   while the map is empty. *This one introduced the critical bug below.*

## Known bugs, unfixed as of 16:15 — do not build on top of these

**1. CRITICAL — extraction loop burns quota.** `extraction_loop()` in
`backend/main.py`. While the map has no nodes it polls every 3s, and since
the mutating `partial` feeds the transcript, the
`transcript == last_extracted` skip never fires while anyone speaks. ~20
Gemini calls/min against the ~10 RPM free-tier cap the file documents itself.
Self-sustaining: an empty extraction result keeps the map empty, keeps
`first_pass` True, keeps it hammering. Backoff is counted in cycles not
seconds, so it's 18s at that cadence, not the ~2min its comment claims.
**Its symptom is "I talk and no cards appear" — likely the real cause of
teammates reporting the app didn't work.**

**2. Spoken level commands fire on the lecturer's own words.**
`backend/services/intent.py` matches bare nouns (`proof`, `intuition`,
`mechanism`, `rigorous`, `deeper`, `simply`) — the most common words in the
lecture being demoed. The 9-word guard doesn't help because the splitter also
splits on commas, manufacturing short fragments. Also costs quota: a false
trigger to L3 fires a real Gemini call.

**3. Level-3 audio cache poisons itself.** `backend/services/tts.py` keys
cached mp3 by (slug, level), never by the spoken text. The speak button
renders on the Rigour tab before deep text exists, so an early click voices
the *definition* into `{slug}_l3.mp3` permanently — wrong audio forever, for
every user and session.

## Who is doing what

A runner-agent has been briefed to fix bugs 1→3 in that order, touching
`backend/main.py`, `backend/services/intent.py`, `backend/services/tts.py`,
and the level section of `frontend/app.js`.

**If that is not you: do not touch those four files.** Take new work in new
files, or in `frontend/style.css`, `README.md`, `PITCH_HANDOFF.md`. Say up
front which files you intend to modify so the conflict is caught before the
merge, not during it.

## Hard constraints — these are not preferences

- **Every Gemini call is blocking on the single event loop.**
  `asyncio.to_thread` deadlocks on that machine (Windows cert-store lookup
  isn't thread-safe under its Avast SSL interception). Never add threads.
  For genuinely async I/O, copy `videogen.py`: `httpx` async client +
  `truststore`.
- **Free-tier API budget is tight and has been exhausted mid-demo before.**
  Any new feature must be explicit about its call volume. Nothing automatic,
  nothing per-node-in-a-loop. Cache by concept slug via
  `backend/services/cache.py` — that pattern is why repeat views are free.
- **Multiple Gemini model names = separate quota pools.** All text generation
  goes through `generate_with_fallback` in `llm.py` for the fallback chain.
  This has saved a live demo already. Don't bypass it.
- LLM text is rendered with `textContent`, never `innerHTML`.
- No new dependencies, no frontend build step, vanilla JS only.
- `.env` is gitignored and holds `GEMINI_API_KEY` + `ELEVENLABS_API_KEY`.
  Never commit it, never invent placeholder keys.
- ElevenLabs **video** generation is 402-blocked on the free tier (verified).
  TTS is not. Don't build anything on video.

## What actually matters in the remaining time

Ranked. This is a hackathon scored on `what you built × how far you ran`,
judged on a live demo.

1. **One machine with real keys and a verified end-to-end run.** Nobody has
   confirmed this since the three features above landed. If it doesn't run at
   19:00, nothing else counts.
2. **A recorded 30-60s backup demo clip.** Not done. It is the only defence
   against the mic, the Wi-Fi, or a quota failing on stage.
3. Bug 1.
4. Bug 2 (a two-minute regex edit).
5. Anything new.

**If you are being asked to start a new feature, push back on that ordering
first.** At T-1h45 with an unverified build and nothing pushed for 20
minutes, a new feature is more likely to cost the demo than to win it.

## Pitch angle, for context on what to prioritise

The wedge is "make live attendance mechanically matter again": this is a
companion artifact that only exists because you were physically there,
listening in real time — not a note-taking tool you could point at a
recording afterwards. Three comprehension levels and voice control serve that
story. Judge it against that when deciding what to build.
