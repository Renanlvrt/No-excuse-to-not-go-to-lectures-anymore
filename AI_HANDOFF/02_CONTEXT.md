# Context — why this app is built the way it is

This document is the "why" behind `03_DECISIONS.md`'s "what." Read it
before rebuilding, because several architectural choices here look wrong
or over-cautious in isolation and are only correct given constraints
discovered the hard way during development. Reversing any of these
without understanding why will likely reintroduce a bug that was already
found, reported by the product owner, and fixed once.

## 1. Why every Gemini call (except video) is synchronous/blocking, not threaded

The natural design for a FastAPI app is to run blocking SDK calls via
`asyncio.to_thread()` so they don't freeze the event loop. **This was
tried and it hangs indefinitely on the development machine.** Root cause:
this machine's Avast antivirus performs SSL interception (MITM) on
outbound HTTPS for scanning purposes. The fix for that is the
`pip-system-certs` package (imported as
`pip_system_certs.wrapt_requests` at the very top of `backend/main.py`,
before anything else) which patches Python's default cert trust to also
trust the Windows certificate store (where Avast's interception
certificate lives). This patch's certificate lookup is not thread-safe on
this machine — calling it from a `to_thread`-spawned worker thread
deadlocks rather than erroring, which is much worse (silent hang, no
traceback, no timeout) than a clean failure would be.

The practical consequence: `backend/services/llm.py`,
`diagram.py`, `qa.py`, `imagegen.py`, `widgetgen.py`, `quizgen.py`, and
`summarygen.py` **all call Gemini synchronously, inline, on the single
shared asyncio event loop**. This means the whole app — every open
WebSocket connection, the periodic extraction timer, every button click —
is serialized behind whichever one of these calls is currently running.
For a single-user hackathon demo this is an acceptable and even simple
trade — a Gemini call takes 1-15 seconds, not enough to feel broken for
one user clicking one thing at a time. It would NOT scale to multiple
concurrent users without a real fix (e.g. a subprocess-based worker pool,
since threads are the specific thing confirmed unsafe here — a subprocess
doesn't share the parent's cert-store lookup state the same way).

`backend/main.py`'s `state["busy"]` flag exists specifically to manage
contention within this single-threaded reality: it stops the periodic
20-second extraction timer from starting a *new* cycle while a
user-triggered action (ask/image/widget/quiz/etc.) is already running, so
a button click doesn't get stuck waiting behind an extraction cycle that
was about to start anyway. It cannot and does not preempt a call already
in flight — nothing can, on one thread.

**Video generation is the one deliberate exception**, and it's async for
a different, additive reason (see item 2) — it uses `httpx.AsyncClient`
with `truststore.inject_into_ssl()` instead of `pip-system-certs`, which
was independently verified to work correctly with real async I/O (genuine
non-blocking, no OS thread involved, so the thread-unsafety issue above
never applies to it).

## 2. Why video generation is spawned via `asyncio.create_task`, not the shared blocking pattern

Video generation is a multi-minute polling operation (create → poll every
4s → up to 75 attempts, ~5 minutes ceiling). If it ran inline like every
other service, it would freeze the *entire app* — every other feature, for
every purpose — for up to 5 minutes on a single video request. That's
categorically worse than the brief 1-15s blocks other features cause, so
this one service is deliberately built differently: `httpx.AsyncClient`
gives genuine non-blocking async I/O on the existing event loop (no
thread, so no interaction with the cert-store deadlock issue), and the
handler is fired via `asyncio.create_task()` from `receive_loop()` so the
caller doesn't await it — the WebSocket stays free to keep receiving
transcript updates and other button clicks while a video renders in the
background.

## 3. Why extraction feeds the existing graph back into the prompt, and merges mechanically in code

An early, simpler design had each extraction call only see the new
transcript chunk and return only new nodes, merged client-side. This is
fragile: without seeing what's already on the map, the model has no way
to know a concept was already covered, and any fuzzy client-side
id-matching (e.g. "is 'gradient descent' the same as 'gradient_descent'
already on the map?") is guesswork. The fix: every extraction call
includes a compact serialization of the graph already built
(id/label/category/mode only, not full definitions — keeps the prompt
lean) and the model is instructed to reuse existing ids for anything
already covered and only add genuinely new nodes/edges.

Critically, **the "never delete" guarantee is not just a prompt
instruction — it's enforced mechanically in `extract_flowchart()`**: for
any node id the model already had on record, the *existing stored fields*
are kept (not overwritten by whatever the model returned this call, which
might paraphrase the definition slightly differently each time), and any
existing node id the model's response simply forgot to re-list is
force-carried-forward into the merged result regardless. This was a
deliberate "don't trust prompt compliance for something this testable"
decision — see the corresponding item in `SUCCESS_CRITERIA.md`
("Never-delete accumulation") which was specifically automated-tested by
running multiple real extraction cycles and asserting every earlier
node id survived.

## 4. Why there's a chain of multiple Gemini model names, not one model

Discovered mid-development, mid-demo: different Gemini model *names*
(e.g. `gemini-3.6-flash` vs `gemini-flash-lite-latest`) draw from
**separate free-tier quota pools**. A single model running out of quota
does not mean Gemini overall is unavailable — trying the next model name
in a fallback chain often succeeds immediately. `llm.py`'s
`generate_with_fallback()` tries `MODEL_FALLBACK_CHAIN` in order, and is
"sticky" — once one model in the chain succeeds, subsequent calls start
from that index instead of re-trying from the top every time (avoids
repeatedly re-discovering the same exhausted model is still exhausted).
`imagegen.py` has an equivalent, separate chain of image-capable models
for the same reason (and includes a paid-tier-likely model last, as a
last-resort long shot, not an expected-to-work option).

## 5. Why generated content is cached forever, by concept label, in plain JSON files

Two things needed to both be true at once, and seemed to conflict:
"infinite variety" (every concept gets a genuinely bespoke widget/image,
not a generic template) and "as few tokens as possible" (the product
owner is on a free-tier Gemini key with real, tight quota). The
resolution: caching isn't at odds with infinite variety, it's what makes
it *affordable* — lecture topics repeat heavily both within one lecture
(if a professor mentions "recursion" three times) and especially across
different lectures over a semester (gradient descent, linear regression,
sorting algorithms, etc. show up over and over). Caching by a normalized
slug of the concept label means the FIRST time any concept is ever seen,
across the entire lifetime of this app (not just this session — the
cache is plain JSON files in `data/`, not per-connection memory, so it
survives restarts and accumulates across every lecture ever run), it
costs one real API call; every subsequent time, anywhere, it's instant
and free. This is what makes "feels infinite" and "uses almost no
tokens" simultaneously true. Widgets and images are cached this way;
quizzes and wrap-up summaries deliberately are NOT cached (see the
docstring in `quizgen.py`/`summarygen.py`) because they intentionally
reflect the CURRENT state of the whole growing map, which changes as the
lecture continues — caching them would show stale content.

## 6. Why generated widgets run in a sandboxed iframe with no `allow-same-origin`

The interactive-simulation feature has the model write and return raw,
executable HTML/JS. This is untrusted code by construction (an LLM
generated it) that must run in the browser. The security model:
`sandbox="allow-scripts"` **without** `allow-same-origin`, loaded via
`.srcdoc` (not a `data:`/`blob:` URL, which browsers would otherwise treat
as inheriting the parent origin in some cases). Without
`allow-same-origin`, the iframe gets a genuinely **opaque origin** — code
running inside it cannot read or write anything belonging to the parent
page, including `parent.document`, cookies, or localStorage, even though
it CAN run scripts and manipulate its own DOM (which is required for the
whole feature to be interactive at all). This was explicitly verified,
not just assumed: a test injected real widget-shaped HTML and confirmed
from *inside* the sandboxed frame's own JS execution context that
`parent.document` access throws a `SecurityError`.

`sandbox` alone doesn't block outbound network requests from inside the
iframe (a malicious/hallucinated `fetch()` to some URL could still fire).
Defense in depth for that specific gap: the backend injects a CSP meta tag
server-side into every generated widget (`_inject_csp()` in
`widgetgen.py`) with `connect-src 'none'` (plus similarly locked-down
`default-src`, `script-src 'unsafe-inline'` only, `frame-src 'none'`,
`form-action 'none'`, `base-uri 'none'`) — this is done in code, every
time, regardless of what the model's own output contains, specifically
because it should never be trusted to prompt compliance for a security
property.

One consequence of the opaque origin: the resize-reporting script
(`ResizeObserver` + `postMessage`) has to `postMessage` to `'*'` (the
child has no way to know a real parent origin to target), and the parent
must validate incoming messages via `event.source === thatIframe.contentWindow`,
**not** `event.origin` — for an opaque origin, `event.origin` is always
the literal string `"null"` (not `undefined`, not omitted), which is not
usable for identifying a specific trusted iframe among possibly several.

## 7. Why the frontend loads the full `d3@7` bundle instead of the smaller standalone `d3-force`

Tried the smaller, more targeted `d3-force` standalone UMD bundle first
(less code to load for a feature that only needs force-simulation, not
all of d3). It throws `"r.timer is not a function"` at runtime — verified
this is because that standalone bundle does not actually include its own
`d3-timer` dependency, despite d3-force needing it internally to drive the
simulation's tick loop. Rather than manually resolving and loading
`d3-timer` as a second separate script (fragile, another thing to keep in
sync), the fix is to load the full `d3@7` bundle
(`https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js`), which is guaranteed
complete and self-consistent. This is more bytes than strictly needed but
was judged not worth the fragility trade for a hackathon build.

## 8. Why `#topbar` is not `position: fixed`, and `#main` doesn't hardcode a top offset

An earlier version had `#topbar` fixed-position with `#main` given a
hardcoded `top: 90px` to sit below it. The topbar's actual rendered
height varies — it contains a live transcript box and a manual-text-input
box that can wrap to more lines depending on window width/content — so
whenever the topbar was genuinely taller than 90px, the right panel's top
content silently rendered *behind* the (opaque) topbar and was unreachable.
This was reported live by the product owner during actual lecture use
("the right panel is behind so hidden"). Fixed by switching the whole page
to a flex column (`#topbar` sized to its own content via `flex-shrink: 0`,
`#main` takes the rest via `flex: 1; min-height: 0`) — no guessed pixel
offset to go stale as content wraps.

## 9. The critical bug: stopping the mic silently broke every other feature

Reported live by the product owner, verbatim: "Ask about this / summarize
this as I am not very sure what everything is talking about / Ask -> this
one is the same, no feedback. Maybe because I stopped the start listening
thing, but it should stop the whole process of the: testing yourself on
this... Or the ask about this..." The root cause: clicking "Stop"
(the same button as "Start listening", toggled) called `ws.close()` —
it fully tore down the WebSocket connection, not just the microphone.
Every other feature (ask, generate simulation, generate image, generate
video, quiz, wrap-up) gates its send on `ws.readyState ===
WebSocket.OPEN`, and the failure mode when that check failed was a
**silent early return with zero user-visible feedback** — the button just
did nothing, indistinguishable from "still loading" or "broken."

This was a genuine architectural flaw, not a superficial bug: the code
conflated "the microphone is listening" with "the backend connection is
up," when they are actually two independent concerns — a student should
be able to stop dictation (e.g. the lecture paused, or they want to ask a
question in a quiet room) without losing the ability to interact with
everything already on the map. The fix, applied at the root rather than
patched around the symptom: the WebSocket lifecycle is now fully decoupled
from mic-listening state. `connect()` is called once at module load and
is independent of the Start/Stop button; a separate `wsConnected` boolean
tracks connection state, and `listening` tracks mic state — the Start/Stop
button touches only `listening` and the mic, never the socket. `ws.onclose`
always attempts to reconnect regardless of whether the mic is currently
listening (previously, reconnect logic may have been gated on/coupled to
listening state as well). Additionally, every previously-silent
`if (!ws || ws.readyState !== OPEN) return;` guard across the whole
frontend (ask, image, widget, video, quiz, check-question) was replaced
with a shared `wsReady()` helper that shows a toast
("Not connected right now - reconnecting automatically, try again in a
moment.") instead of failing silently, so even a genuine transient
disconnect is now visibly communicated instead of looking broken.

## 10. Why there's a global toast system instead of relying on the single `#status` line

Before this session's fixes, the only global feedback mechanism was a
single `<p id="status">` line in the top bar. It's easy to miss (small,
top of a busy screen, no persistence, gets overwritten by the next status
change), and several real failures (quiz silently not working, the
Stop-breaks-everything bug) were specifically reported as "no feedback"
— the underlying calls WERE sometimes failing correctly, but nothing told
the user that clearly. The fix: a dedicated, hard-to-miss toast system
(`showToast(message, kind, duration)`, centered top of viewport, above
everything via `z-index: 500`, red for errors / green for success,
auto-dismissing) used consistently for every error path across the app —
Gemini-unreachable errors, mic-permission errors, WebSocket-not-ready
errors, and node-scoped action failures all now surface through it
(node-scoped failures also still patch a small inline error banner into
the specific card/panel, since "which concept failed" matters and a toast
alone wouldn't convey that).

## 11. Why the quiz button was reported broken, and the actual fix

The product owner's report: "generate quizz is not working or at least
there is no feedback like what it is." The underlying cause here was
UI-ordering, not a backend failure: the "Generating quiz..." loading text
was only rendered into the quiz modal *after* the `wsReady()` check
passed — so if the check failed silently (pre-fix, before the toast
system existed) or even just before the modal was visibly open, the user
saw nothing happen. Fixed by reordering: `quizOverlay.classList.add("open")`
now happens FIRST (so the modal is visibly open before anything else,
giving any subsequent toast something to be visible against), then
`wsReady()` is checked (itself now toast-visible on failure per item 10),
then the "Generating quiz..." loading text renders into the now-open
modal.

## 12. Why "wrap up" replaced the old "⚡ Generate diagram now" button

Verbatim product owner feedback: "make a wrapup button on top instead of
the create diagram button which has never been used." The manual
force-extraction button was dead weight — the automatic 20-second
extraction timer plus the always-available manual-text-input box already
covered every real need to trigger extraction, and no one had ever
actually used the manual button in real usage. It was removed and its
slot in the top bar was given to the new, actually-requested wrap-up
feature. The wrap-up modal is explicitly read-only with respect to the
live map — generating it makes a single batch summarization call and
otherwise touches nothing; closing it returns to a fully live, fully
functional map that can keep growing and be wrapped-up again later with
more content.

## 13. Why the analogy field was added, and why it renders before the definition

Verbatim product owner request: "also make it so that each concept on the
right panel starts with an analogy (add this each time it creates a cell
(box))." The reasoning (informed by how the product owner described their
own need — "as I am not very sure what everything is talking about"): an
everyday relatable comparison is a faster way into an unfamiliar concept
than a formal definition, so it's the FIRST thing shown, before the more
precise definition. The `SYSTEM` prompt in `diagram.py` is explicit that
the analogy must "genuinely click, not just restate the definition in
different words" — this was written deliberately to avoid the model
producing a lazy analogy that's really just the definition reworded.

## 14. Why a local LLM (e.g. Mistral) was explicitly rejected

Directly asked and directly answered during development: a local model
would very likely produce noticeably worse output on the two hardest
generation tasks this app does — reliably well-formed structured JSON
(the diagram-extraction and quiz/summary schemas) and non-trivial,
correct, safety-constrained widget/HTML-generation code (the interactive
simulation feature). Both tasks benefit disproportionately from a
stronger model; a same-sized-or-smaller local model would regress both.
Per the product owner's own explicit conditional ("If it makes it worse,
let's not put any local llm though"), no local LLM was implemented
anywhere in this app. Do not add one to the rebuild without a new,
explicit ask.

## 15. What was researched but deliberately not built, and why

- **A literal real-time "whiteboard" that draws itself stroke-by-stroke as
  the lecture is spoken** (as opposed to the structured-JSON-then-render
  approach this app actually uses): researched and found not reliably
  buildable with current LLM capabilities — no model reliably emits valid
  *incremental* SVG (partial/malformed SVG mid-stream is common and there's
  no established tolerant-partial-SVG rendering pattern to paper over
  that), unlike JSON, where partial-object parsing is a well-trodden
  problem with known solutions. This is also why the structured-JSON
  architecture this app uses was cross-checked against real prior art
  (generative-UI patterns from Vercel's AI SDK ecosystem, DeepDiagram, and
  the `excalidraw-skill` pattern) — all of them converge on structured
  JSON over raw incremental SVG/canvas drawing for exactly this reason.
- **A Chrome extension** instead of a plain web app: researched and
  rejected. This app's mic input uses plain `getUserMedia`, which needs no
  special extension permissions; there's no need to capture *another* tab's
  audio or overlay another site. An extension would only have added
  complexity (a different security/permissions model) without solving any
  problem this app actually has, and would have complicated the
  iframe-sandboxing story for generated widgets for no benefit.
- **Cross-lecture persistent knowledge graph (SQLite-backed, concepts
  carry over between separate lecture sessions)**: the product owner
  called this idea "extremely interesting" when it came up, but it was
  explicitly scoped out of this MVP as a deliberate stretch goal — it
  requires real new infrastructure (a persistence layer keyed by
  course/topic, some notion of session boundaries, concept
  matching/merging across sessions which is a harder version of the
  same-session merge problem in item 3) that wasn't attempted here. Do not
  build this as part of an "exact reproduction" of this MVP — it was never
  part of the MVP baseline.
- **A time-travel slider** (scrub through snapshots of the map as it grew
  earlier in the session) and an **end-of-lecture scrollytelling recap**
  (auto-panning camera walkthrough of the final map): both proposed by the
  product owner via voice dictation, both judged as good, relatively
  low-risk ideas that wouldn't need any new API calls (they'd replay
  already-fetched data) — but neither was implemented. Good candidates for
  a *next* iteration, explicitly not part of what "reproduce this MVP
  exactly" means.
