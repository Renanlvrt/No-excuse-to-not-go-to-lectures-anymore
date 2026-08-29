# AI Handoff Package — Lecture → Living Mind-Map

Give an AI agent this entire `AI_HANDOFF/` folder (all 9 files, in order)
to have it reproduce this app from scratch with the intent of **zero
behavioral drift** from the working MVP it was extracted from. Every file
is self-contained (markdown or PDF, no loose multi-file folders) so the
whole package can be handed over as 9 flat files. Read `01_PRD.md` →
`02_CONTEXT.md` → `03_DECISIONS.md` → `04_UI_VISUAL_SPEC.md` →
`05_SUCCESS_CRITERIA_AND_STATUS.md` → `06_BACKEND_PROMPTS_VERBATIM.md`, in
that order, then use `07_SOURCE_CODE_COMPLETE.md` and
`08_SCREENSHOTS_REFERENCE.pdf` as ground truth for anything still
ambiguous after reading the first six.

## Can this actually be reproduced infallibly?

Direct answer: prose descriptions alone — even extremely detailed ones —
cannot guarantee byte-identical behavior from a different AI agent, because
any paraphrase of a prompt string, any rounded-off color value, any
"roughly" on a timeout number is a place drift can creep in. That's why
this package leans on a second, stronger mechanism instead of relying on
prose alone: **`07_SOURCE_CODE_COMPLETE.md` is a literal, complete copy of
the actual working code** (every backend service file, every frontend
file, `requirements.txt`, each in its own clearly-headed section) at the
moment this package was written. The other numbered documents explain
intent, sequence, and the *why* behind non-obvious choices — but wherever
a document and `07_SOURCE_CODE_COMPLETE.md` could conceivably disagree,
`07_SOURCE_CODE_COMPLETE.md` is correct, because it's not a description,
it's the thing itself, copied verbatim.

The instruction to whichever agent works from this package should be:
**start by splitting `07_SOURCE_CODE_COMPLETE.md` back out into real
files at the paths given in each section heading (its own intro explains
the exact directory structure and a 4-backtick-fence gotcha to watch for),
get it running, verify it against `05_SUCCESS_CRITERIA_AND_STATUS.md`,
and only then treat any further work as a deliberate, intentional
departure** — not a fresh reimplementation from prose. That is the most
reliable path to "exact same result," short of literally handing over
the git repository itself (which is also an option — see below).

## What's in this folder

| file | what it's for |
|---|---|
| `00_START_HERE.md` | this file |
| `01_PRD.md` | what the app is, who it's for, the exact user flow, explicit non-goals |
| `02_CONTEXT.md` | the *why* behind every non-obvious architectural decision, including 3 real bugs that were found and fixed live — do not silently reintroduce these |
| `03_DECISIONS.md` | exhaustive, itemized decision log: exact library choices, exact model chains, exact timeouts, exact WebSocket message shapes, exact cache format |
| `04_UI_VISUAL_SPEC.md` | every exact color, dimension, font size, button label/emoji, and CSS behavior, extracted directly from the real stylesheet |
| `05_SUCCESS_CRITERIA_AND_STATUS.md` | the objective, already-Playwright-verified acceptance checklist — a rebuild should be able to pass the same checks |
| `06_BACKEND_PROMPTS_VERBATIM.md` | every LLM system prompt and prompt template used anywhere in the backend, copied character-for-character |
| `07_SOURCE_CODE_COMPLETE.md` | a literal, complete copy of the real working `backend/`, `frontend/`, and `requirements.txt`, all 18 files concatenated into one — the ultimate source of truth |
| `08_SCREENSHOTS_REFERENCE.pdf` | the 3 real screenshots of the actual running app, one per page — see notes below, one caveat |

## Screenshot notes (read before using them as a style reference)

`08_SCREENSHOTS_REFERENCE.pdf` is 3 pages, one screenshot per page, in the
order listed below. All 3 are real captures of the app being used live during an
actual lecture (a history lecture covering Socrates, Plato, Aristophanes),
and are the most reliable available reference for card styling, panel
layout, the analogy callout, and button iconography. **One caveat**: they
were taken slightly before the final round of changes in this handoff
package, so they show the OLD top bar (still has the now-removed
"⚡ Generate diagram now" button, no "🎁 Wrap up" and no "📝 Quiz me"
button yet, no toast notifications visible). Everything else visible in
them — card flip/color/border styling, the right panel's section layout,
the analogy callout with the 💡 prefix, the simulation/video/image button
styling, dark-mode palette — matches the current, final spec in
`04_UI_VISUAL_SPEC.md` and did not change after these were taken. Treat
the top bar specifically as historical, and everything else as current.

- **Page 1** (diagram readability) — a denser, fully-built-out
  machine-learning-lecture map (logistic/linear regression, SVM, KNN,
  overfitting/underfitting) with no panel open, demonstrating layout
  legibility and category-color variety at higher node counts.
- **Page 2** (panel with simulation) — the right panel open on
  "Aristophanes," showing the analogy callout (💡, italic, left-accent
  border) above the definition, and the interactive-simulation section
  already generated and displaying real widget content (a mini
  "Aristophanes vs. Plato" perspective-comparison tool).
- **Page 3** (panel full sections) — scrolled further down the same
  panel, showing the interactive-simulation button state, the "Teaching
  video" section, the "Generate image" button, and the "Ask about this"
  input, all in their real rendered positions/order.

## If handing this to an agent that can access the actual git repository

If at all possible, prefer giving the rebuilding agent direct access to
the actual git repository this was extracted from (see the project's own
git history) over this document package alone — recent commits capture
the same information with perfect fidelity and no transcription risk.
This `AI_HANDOFF/` package exists specifically for the case where that's
not possible (e.g. handing off to a different agent/tool/environment with
no repo access) and prose-plus-source-snapshot is the best available
substitute.
