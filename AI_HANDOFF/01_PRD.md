# Product Requirements Document — Lecture → Living Mind-Map

## Read this first

This document, together with `02_CONTEXT.md`, `03_DECISIONS.md`,
`04_UI_VISUAL_SPEC.md`, `05_SUCCESS_CRITERIA_AND_STATUS.md`,
`06_BACKEND_PROMPTS_VERBATIM.md`, `07_SOURCE_CODE_COMPLETE.md`, and
`08_SCREENSHOTS_REFERENCE.pdf`, is a complete handoff package for
rebuilding this exact application from scratch. The instruction from the product owner was
explicit: **the rebuild must produce the exact same result**, not a
reinterpretation. Where this document says "must," it means must. Where it
gives an exact string, color, number, or model name, copy it exactly —
do not paraphrase, do not "improve," do not substitute a similar value.

The actual working codebase this was extracted from already exists and is
the ultimate source of truth if anything here is ambiguous — see
`03_DECISIONS.md` for the file paths. This is a hackathon project. The
codebase is small (13 Python files, 3 frontend files). Reading the actual
files is always more reliable than this summary if they ever disagree —
but as of the day this was written, they do not disagree; this document was
written by re-reading every source file fresh.

---

## 1. What this product is

A web app that sits open on a laptop screen while a student attends a live
lecture. It listens (via the browser's microphone, or via pasted text as a
fallback) to what's being said, and in near-real-time builds a growing,
visual, interactive "mind-map" of the hard/confusing concepts from the
lecture — not a transcript, not a generic summary, but a structured
concept graph where every node is a rich, explorable object: an analogy,
a definition, an optional animated step-walkthrough, an AI-generated
interactive simulation you can play with, an AI-answerable Q&A box, an
optional illustrative image, and an optional short teaching video.

It was built for **RUN/HACK**, a running-themed hackathon in London
(the.runninghackathon.com), where the build constraint was: build it while
literally running a 400m loop, teammates take turns building and running,
product quality scored by "product quality × distance run." This MVP was
built before the hackathon, as a rehearsal/foundation to bring into the
actual event.

## 2. Who it's for

The primary and only user during MVP development was the product owner
themselves — a student who wants to run this during their own lectures.
The product is explicitly designed around a **single concurrent user, one
browser tab** — not a multi-tenant SaaS. Do not add multi-user
infrastructure (auth, multiple simultaneous rooms, etc.) unless explicitly
asked; it was never a requirement and would be over-engineering for this
brief.

## 3. Core user flow (must reproduce exactly)

1. Open `http://localhost:8010/static/index.html` in Chrome (Web Speech
   API used for mic transcription is Chrome/Edge-only — this is a known,
   accepted constraint, not a bug to fix).
2. Click **▶ Start listening**. Browser mic permission prompt appears.
   Speech recognition begins. A live transcript accumulates in the "Live
   transcript" box in the top bar.
3. Separately (this is a fully independent fallback path, always
   available, always working, proven more reliable in testing than live
   mic transcription): the user can type or paste lecture text directly
   into the "No mic, or recognition not picking up?" textarea. Every
   keystroke sends the combined transcript to the backend.
4. Roughly every 20 seconds (configurable, see `03_DECISIONS.md`), the
   backend sends the accumulated transcript to Gemini, which extracts new
   concepts worth diagramming and returns the complete updated concept
   graph. New concept cards animate into existence on the canvas,
   physics-laid-out, connected by labeled edges to related concepts.
   **Nothing already on the map is ever deleted or forgotten**, no matter
   how long the session runs or how much new content arrives.
5. The student can click **⏸/▶ Start listening** to stop mic listening at
   any time — this stops the microphone only. The WebSocket connection to
   the backend, and every other feature (asking questions, generating
   simulations, generating a quiz, generating a wrap-up), continues to
   work exactly as before, indefinitely, whether or not the mic is
   listening. This was a real bug that was found, reported, and fixed
   during development — see `02_CONTEXT.md` for the full story. **Do not
   regress this**: stopping the mic must never disable anything else.
6. The student clicks any card on the canvas. The card does a 3D flip
   animation (cosmetic) and — the real interaction — a large panel opens
   on the right side of the screen showing, top to bottom, in this exact
   order:
   - Category badge (colored)
   - Concept title
   - **Analogy** (shown first, before the definition, styled as a quoted
     callout with a 💡 emoji prefix) — an everyday, relatable comparison
   - Definition (1-3 sentences, more precise than the analogy)
   - Error banner if the last action on this node failed (only if
     applicable)
   - **Process walkthrough** section (only if this concept is a
     multi-step process): an animated stepper (numbered circles connected
     by a line, the active circle pulses/glows/scales via real CSS
     keyframe animation, completed circles turn solid green with a
     checkmark) with Animate/Pause/Resume/Reset controls and a detail box
     showing the current step's text
   - **Interactive simulation** section: a button, "🧩 Generate interactive
     simulation." Clicking it has Gemini write a real, playable,
     self-contained HTML/JS/CSS widget specific to that exact concept
     (e.g. for linear regression: click to add data points, watch a line
     re-fit live). Rendered in a sandboxed iframe. Once generated: an
     "⛶ Open large" button (pops it into a full-viewport modal), a
     "↻ Reset" button (reloads the same generated HTML fresh, zero API
     cost), and a "🔄 Regenerate" button (asks for a brand new version,
     real API call). Below the simulation: a "🧠 Test yourself on this"
     button that generates one active-recall multiple-choice question
     specifically testing whether the student understood what the
     simulation demonstrated.
   - **Teaching video** section: a button, "🎬 Generate teaching video."
     (Built completely; confirmed blocked on the free-tier ElevenLabs key
     used during MVP development — see `02_CONTEXT.md`. Must be built
     exactly as specified regardless, since it will work once a Pro-tier
     key is available at the hackathon.)
   - **Image** section: a button, "🖼️ Generate image" — an on-demand
     Gemini-generated illustrative image for the concept.
   - **"Ask about this"** section: a text input + Ask button. Free-form
     question about this specific concept, answered by Gemini in 2-4
     plain-language sentences. Answers persist on the card (visible again
     if you flip away and back, or navigate to another card and return).
7. At any time, the student can click **🔍 Fit to view** (auto pan/zoom to
   frame the whole graph), **📝 Quiz me** (generates a 5-8 question
   multiple-choice quiz over everything on the map so far, in a modal,
   one question at a time, click an answer to immediately see
   correct/incorrect + a one-sentence explanation, score shown at the
   end, retake button), or **🎁 Wrap up** (generates a short bullet-point
   summary of the whole lecture so far as a clean standalone "webpage"
   styled modal — title, bullet list, a hint that closing it changes
   nothing). Closing the wrap-up or quiz modal returns to the fully live,
   fully interactive map — **the lecture is not "ended" by wrap-up**; the
   student can keep listening, keep asking questions, keep generating
   simulations, and generate a fresh wrap-up later that reflects the
   larger map.

## 4. Explicit non-goals (do not build these into the MVP baseline)

- **No literal real-time "whiteboard" that draws itself stroke-by-stroke
  as the lecture is spoken.** This was researched extensively (see
  `02_CONTEXT.md`) and confirmed not reliably buildable with current LLM
  capabilities — no model reliably emits valid incremental SVG, and no
  established tolerant-partial-SVG rendering pattern exists. The
  structured-JSON-then-render approach this app uses (see below) is the
  validated correct architecture instead, confirmed against real prior
  art (Vercel's generative-UI SDK, DeepDiagram, excalidraw-skill all
  converge on structured JSON over raw SVG).
- **No local LLM (e.g. Mistral).** Explicitly evaluated and rejected —
  would produce meaningfully worse structured JSON and worse-quality
  generated widget code than Gemini's flash-lite tier, for both of the
  two hardest tasks this app does.
- **No cross-lecture persistent knowledge graph / SQLite-backed concept
  memory across sessions.** A genuinely good idea (flagged explicitly by
  the product owner as "extremely interesting"), but explicitly scoped
  OUT of the MVP baseline as a deliberate stretch goal requiring real new
  infrastructure ("a clear day or more" of dedicated build time). Do not
  build this unless separately instructed.
- **No Chrome extension.** Researched and explicitly rejected — a plain
  web app has no real disadvantage for this use case (mic input via
  `getUserMedia`, no need for tab-audio capture of another site or
  on-page overlay of another app), and an extension would only complicate
  the iframe-sandboxing story for generated widgets.
- **No multi-user/auth/accounts.** Single runner, single tab.
- **A "time-travel slider"** (scrub through snapshots of the map as it
  grew) and an **"end-of-lecture scrollytelling recap"** (auto-panning
  camera walkthrough of the final map) were both proposed and judged
  good, low-risk, no-new-API-cost ideas, but were NOT implemented in this
  MVP — noted here as good next features, not part of the baseline to
  reproduce exactly.

## 5. Success criteria

See `05_SUCCESS_CRITERIA_AND_STATUS.md` for the complete, itemized,
already-verified checklist (every item was verified by actually driving
the running app with Playwright and real API calls, not by inspection).
At the point this handoff was written: 10/10 core interaction categories
verified working end-to-end, plus quiz/wrap-up/check-question/analogy all
verified with real API calls and real generated content. The one
structurally-unverifiable item is real microphone speech-to-text accuracy
in an automated test (confirmed working manually by the product owner
live during an actual lecture, including finding and reporting 3 real
bugs from that live use, all fixed and re-verified).

## 6. Sponsors / hackathon context (informational, not a build requirement)

Built with the intent of using RUN/HACK sponsor technology to be
competitive in judging. Confirmed sponsor list was not published at the
time of building — "ElevenLabs" and a sponsor sounding like "2 Valley"
(guessed as Tavily) were the product owner's best guesses from the
hackathon's branding pattern, not confirmed. Gemini ended up being the
actual, only, fully-working LLM backend (a working API key was found on
the product owner's machine; this is what powers every text/image
generation feature). An ElevenLabs API key was added later in development
specifically for image/video generation — confirmed via a real live API
call to return `402 Payment Required` on the free tier for image
generation, and video generation is documented as paid-plan-only entirely.
See `02_CONTEXT.md` for the full investigation.
