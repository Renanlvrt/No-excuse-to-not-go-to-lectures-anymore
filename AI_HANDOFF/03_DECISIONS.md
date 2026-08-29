# Decisions log — exhaustive, non-summarized

This is a flat, itemized list of every concrete technical decision made
building this app: exact library/package choices, exact constants,
exact file layout, exact message-protocol shapes. Where `02_CONTEXT.md`
explains *why*, this document is the reference for the exact *what* —
copy these values exactly when rebuilding. Nothing here should need
re-deriving or guessing.

## Repo layout

```
backend/
  __init__.py
  main.py                 FastAPI app + the single /ws/lecture WebSocket endpoint
  services/
    __init__.py
    llm.py                 shared Gemini-call-with-model-fallback helper
    diagram.py              stateful graph extraction (the core feature)
    qa.py                   per-node follow-up Q&A
    imagegen.py              on-demand image generation
    widgetgen.py             on-demand interactive HTML widget generation
    videogen.py              on-demand teaching video generation (ElevenLabs)
    quizgen.py               whole-lecture quiz + per-simulation check question
    summarygen.py            end-of-lecture wrap-up summary
    cache.py                 shared persistent JSON-file cache helper
    transcribe.py            UNUSED - ElevenLabs speech-to-text, kept but not wired in
    enrich.py                UNUSED - Tavily search enrichment, kept but not wired in
frontend/
  index.html               markup shell, loads style.css + d3 CDN + app.js
  style.css                 all styling (see 04_UI_VISUAL_SPEC.md)
  app.js                    all client-side logic
data/                       created at runtime: {cache_name}_cache.json files, videos/
requirements.txt
start.ps1                   convenience launcher
.env                         GEMINI_API_KEY, ELEVENLABS_API_KEY (not committed)
README.md
SUCCESS_CRITERIA.md          objective, itemized, Playwright-verified checklist
```

`transcribe.py` and `enrich.py` exist and are fully written but are
**dead code, never imported by `main.py`**, kept from an earlier
exploration phase (ElevenLabs STT and Tavily search were considered as
sponsor-tech integrations; no working Tavily key was ever found, and
browser-native Web Speech API was used for transcription instead — free,
zero backend involvement). Do not treat their presence as meaning they're
wired in — verify against `main.py`'s imports, which is the ground truth
for what's actually active.

## Backend port and run command

Runs via `uvicorn backend.main:app --port 8010`. The app is served at
`http://localhost:8010/static/index.html` — note the URL includes
`/static/`, this is not the bare root. `start.ps1` is the convenience
wrapper the product owner actually runs.

## Python package choices (exact — from `requirements.txt`)

```
pip-system-certs
fastapi
uvicorn[standard]
websockets
python-multipart
requests
elevenlabs
google-generativeai
tavily-python
python-dotenv
httpx
truststore
```

Notable, deliberate choices within this list:
- **`google-generativeai`, not `google-genai`.** Google's newer official
  SDK is `google-genai`; this app deliberately uses the older
  `google-generativeai` package (imported as `import google.generativeai
  as genai`). This was the package already working on the dev machine and
  switching was never attempted — behavior verified against THIS
  package's actual runtime behavior (e.g. the `inline_data.data`-is-raw-
  bytes-not-base64 finding in `imagegen.py`, and the
  `generation_config` needing to be a plain dict rather than a
  `genai.GenerationConfig` for image calls specifically) may not transfer
  directly to `google-genai`'s different API surface. If rebuilding
  against `google-genai` instead, re-verify these specific behaviors
  rather than assuming they carry over.
- **`pip-system-certs`**: imported for its side effect only
  (`import pip_system_certs.wrapt_requests`), at the very top of
  `backend/main.py`, before any other backend import. See
  `02_CONTEXT.md` item 1 for why. This patches the default `requests`/
  `urllib3`-level trust store; it is NOT used for the video-generation
  service, which uses `truststore` instead (see next item).
- **`httpx` + `truststore`**: used exclusively by `videogen.py`, and only
  there. `truststore.inject_into_ssl()` is called once at module import
  time. This is a deliberately different cert-trust mechanism from
  `pip-system-certs`, chosen specifically because it was verified to work
  correctly with genuine async I/O (see `02_CONTEXT.md` item 2) — do not
  consolidate these into one mechanism without re-verifying both still
  work for their respective call patterns (sync blocking calls for
  everything else, real async for video).
- **`elevenlabs`** (the Python SDK) is a listed dependency but the actual
  video-generation code in `videogen.py` does NOT use this SDK — it calls
  the ElevenLabs REST API directly via raw `httpx` requests. The SDK
  import only appears in the unused `transcribe.py`.
- **`tavily-python`**: only used by the unused `enrich.py`.

## Frontend dependencies

Exactly one external script tag, no package manager, no build step, no
bundler:
```html
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
```
No React/Vue/Svelte/etc. — `frontend/app.js` is plain vanilla JS using
`document.createElement`/`.textContent` (deliberately, not
`innerHTML` — see the XSS-safety note below), manually managing all DOM
updates. No CSS framework/Tailwind — `style.css` is hand-written plain
CSS with custom properties for theming.

## Environment variables (`.env`, not committed to the repo)

- `GEMINI_API_KEY` — required, powers every text/image generation
  feature; the app has no fallback if this is missing/invalid beyond
  surfacing errors through the toast system
- `ELEVENLABS_API_KEY` — optional; if unset/blank, `main.py` reads it as
  `""` via `(os.getenv("ELEVENLABS_API_KEY") or "").strip()` and the
  video-generation handler immediately replies with a node-scoped error
  (`"No ElevenLabs API key configured."`) rather than attempting a call
  — this is checked BEFORE calling `generate_video()`, not caught as an
  exception from within it
- `TAVILY_API_KEY` — read by the unused `enrich.py` only; irrelevant to
  current behavior

## Exact Gemini model chains, in exact fallback order

Text/JSON chain (`backend/services/llm.py`, `MODEL_FALLBACK_CHAIN`, used
by `diagram.py`, `qa.py`, `widgetgen.py`, `quizgen.py`, `summarygen.py`,
and the video-prompt-writing stage of `videogen.py`):
```python
MODEL_FALLBACK_CHAIN = [
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
]
```
Sticky index (`_working_model_index`) — once a call at index `i`
succeeds, the NEXT call starts its own attempt order at `i`, cycling
around (`order = list(range(i, len(chain))) + list(range(i))`), so a
previously-exhausted earlier model isn't re-tried first every single call.

Image chain (`backend/services/imagegen.py`, `IMAGE_MODEL_CHAIN`, its own
separate chain, NOT reusing the text chain or its sticky index):
```python
IMAGE_MODEL_CHAIN = [
    "gemini-3.1-flash-image",
    "gemini-3-pro-image-preview",
    "gemini-3-pro-image",
]
```
Ordered cheapest/most-likely-free-tier-available first, most-likely-to-
require-billing last (per the docstring in `imagegen.py` — the 3rd entry
is a "long shot fallback," not expected to routinely succeed on a
free-tier key).

Google's model lineup moves fast; if any of these exact model id strings
are retired by the time of a rebuild, the FALLBACK PATTERN (multiple
model names → separate quota pools → try in order) is the decision to
preserve, not necessarily these exact literal strings — but start with
these exact strings and only change them if they genuinely no longer
exist, not preemptively.

## Exact timeout values, per call site, and why

| call | timeout | why |
|---|---|---|
| `diagram.py` extraction | 15s | default text-call timeout |
| `qa.py` ask | 15s | default text-call timeout |
| `widgetgen.py` widget generation | **18s** (not the 15s default) | a real successful call measured 12.6s in testing; a tighter-than-generous per-model timeout bounds the worst case across the whole 4-model fallback chain (previously up to 100s total across 4 models at 25s each) without cutting into the margin a genuine slow-but-working call needs |
| `imagegen.py` per model | 30s (via `request_options={"timeout": 30}`) | image generation is slower than text |
| `quizgen.py` whole-lecture quiz | 20s | larger prompt (whole concept map), more output (5-8 questions) |
| `quizgen.py` check-question | 15s | single short question, same as default |
| `summarygen.py` wrap-up | 20s | same reasoning as quiz — larger batch call |
| `videogen.py` video-prompt-writing stage (Gemini) | 15s | default text-call timeout |
| `videogen.py` ElevenLabs create call | 20s (httpx client timeout) | initial POST, not the long poll |
| `videogen.py` polling | 4s interval, 75 max attempts (~5 min ceiling) | see `02_CONTEXT.md` item 2 |
| `videogen.py` final video download | 60s (separate httpx call) | downloading actual video bytes, larger payload |

All of the above are PER-MODEL-ATTEMPT timeouts inside a fallback loop,
not a single overall timeout for the whole multi-model attempt sequence
— a full fallback traversal can take up to (timeout × chain length) in
the worst case.

## Extraction cadence

```python
EXTRACTION_INTERVAL_SECONDS = 20  # backend/main.py
MAX_BACKOFF_SKIPS = 6
```
Every 20 seconds (or immediately if the frontend sends `{"force": true}`
on a transcript-update message, via `force_event`), the accumulated
transcript is checked against `state["last_extracted"]` — if unchanged
since the last successful extraction and not forced, the cycle is
skipped entirely (no Gemini call for no new content). On an extraction
error, `backoff_skips_remaining` is set to `MAX_BACKOFF_SKIPS` (6),
meaning the next 6 normal timer ticks (~2 more minutes) are skipped
before trying again — deliberately conservative to avoid hammering an
API that just said no. A `forced` extraction (explicit manual trigger)
bypasses both the "unchanged transcript" skip and the backoff skip.

The transcript passed to the model is truncated to its last 4000
characters (`transcript_so_far[-4000:]` in `diagram.py`) — older content
silently drops out of what the MODEL sees on each extraction call, though
the full untruncated transcript remains visible to the user in the UI's
own transcript box the whole time.

## WebSocket message protocol (exact shapes)

Single endpoint: `/ws/lecture`. All messages are JSON. Client → server
message `type` values and their payload shape:

- (no `type` key at all — the default/implicit case): a transcript
  update, `{"text": "...", "force": true|false (optional)}`. `force:true`
  triggers an immediate extraction cycle instead of waiting for the timer.
- `{"type": "ask", "node_id": "...", "question": "..."}`
- `{"type": "generate_image", "node_id": "...", "force": true|false}`
- `{"type": "generate_widget", "node_id": "...", "force": true|false}`
- `{"type": "generate_video", "node_id": "...", "force": true|false}`
- `{"type": "generate_check", "node_id": "..."}`
- `{"type": "generate_quiz"}`
- `{"type": "generate_summary"}`

Server → client message `type` values:
- `{"type": "diagram", "data": {"nodes": [...], "edges": [...]}}` — the
  full current graph, sent after a successful non-empty extraction
- `{"type": "empty"}` — extraction ran but produced no nodes (e.g. before
  any concept-worthy content has been said yet)
- `{"type": "answer", "node_id", "question", "answer"}`
- `{"type": "image", "node_id", "image_base64", "cached": true|false}`
- `{"type": "widget", "node_id", "html", "cached": true|false}`
- `{"type": "video", "node_id", "video_url": "/videos/{filename}", "cached": true|false}`
- `{"type": "check_question", "node_id", "question": {...quiz-shaped object...}}`
- `{"type": "quiz", "questions": [...]}`
- `{"type": "summary", "summary": {"title": "...", "bullets": [...]} | null}`
- `{"type": "error", "node_id": "..." (present for node-scoped actions), "context": "ask"|"generate_image"|"generate_widget"|"generate_video"|"generate_check"|"generate_quiz"|"generate_summary"|undefined (undefined for extraction-loop errors), "message": "...", "needs_pro": true (only present on the ElevenLabs 402 case)}`

Every node-scoped action error includes `node_id` even when the node
itself couldn't be found (`msg.get("node_id")` is used as a fallback in
that branch) specifically so the frontend can still reset that card's UI
state (e.g. un-stick a "Generating..." button) — see `02_CONTEXT.md`
item 9/10 for why this matters; an error the frontend can't attribute to
a specific card is one that silently leaves that card's UI broken.

## Node/graph JSON schema (the core data model)

```json
{
  "nodes": [
    {
      "id": "short_snake_case_id",
      "label": "short label, <=4 words",
      "analogy": "1 short sentence, everyday comparison",
      "definition": "1-3 sentences",
      "category": "one short lowercase word: math | code | process | theory | warning | definition | interactive | (anything else, gets a deterministic hash color)",
      "mode": "definition" | "steps" | "interactive",
      "steps": [{"label": "short step name", "detail": "1 sentence"}]
    }
  ],
  "edges": [{"from": "id", "to": "id", "label": "short relation phrase"}]
}
```
`steps` is present (non-empty) only when `mode` is `"steps"` or
`"interactive"` — enforced by `_normalize_node()` in `diagram.py`, which
downgrades `mode` back to `"definition"` if `steps` is missing/empty even
if the model tagged it otherwise.

## Cache file format

`backend/services/cache.py`: one flat JSON file per cache namespace,
`data/{cache_name}_cache.json` — e.g. `data/widgets_cache.json`,
`data/images_cache.json`. Each file is a flat dict:
`{"<slugified_label>": <cached_value>}`. Slugification:
`re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "unnamed"` —
this exact regex is used identically in `cache.py` AND independently
re-implemented in `videogen.py`'s own `_slug()` (video files are cached
as `data/videos/{slug}.mp4` on disk directly, not through the shared
`cache.py` JSON-file mechanism, since they're binary video files, not
JSON-serializable values). Access is guarded by a single
`threading.Lock()` — deliberately simple (single-process, effectively
single-writer-at-a-time given the whole app is single-threaded anyway per
`02_CONTEXT.md` item 1), not a database, not designed for concurrent
multi-process access.

Widgets and images cache the FULL generated value forever, keyed only by
label — same label = same cached result returned instantly, regardless of
how much time has passed or how many server restarts happened in
between, unless the caller explicitly passes `force=True` (the
"Regenerate" button), which always makes a fresh call and overwrites the
cache entry.

## XSS/content-safety decision

The frontend builds all dynamic DOM content (card labels, definitions,
analogies, Q&A text, step text) via `document.createElement(...)` +
`.textContent = ...`, never via `innerHTML` or string-concatenated HTML
for LLM-sourced text. This was a deliberate choice specifically because
LLM output is untrusted input that could contain something that looks
like markup (verified via a real test: a label containing
`<img src=x onerror="...">` and a definition containing `<script>...`
rendered as inert literal text, neither fired) — `textContent` makes this
category of bug structurally impossible rather than relying on escaping
logic that could have a gap. The ONE deliberate exception is the
generated-widget HTML itself, which is intentionally treated as
executable code, but sandboxed per `02_CONTEXT.md` item 6 rather than
sanitized-and-inlined.

## `showToast` signature and defaults

```js
function showToast(message, kind = "err", duration = 6000)
```
`kind` is either `"err"` (default, red, `var(--err)` background) or
`"ok"` (`.toast-ok` class, green, `var(--accent)` background). Default
visible duration 6000ms before auto-dismissal.

## What "cached" means to the end user, and why it's surfaced

Both the `image` and `widget` (and `video`) server response payloads
include a `"cached": true|false` boolean. This isn't just an internal
implementation detail — it's sent to the frontend specifically so the UI
could (and, if not already, should) distinguish "this took 0 tokens,
you've effectively seen this exact widget/image for this concept before
somewhere" from "this was a fresh real API call." Preserve this field in
any rebuild even if the UI doesn't currently do much with it visually —
it's the hook for the "close to token limit, make it visible" style
feedback the product owner asked about (see `01_PRD.md` §6 and
`02_CONTEXT.md`), even though that specific quota-warning UI itself was
deliberately NOT built this round (nothing ElevenLabs-side is live to
warn about yet, and Gemini free-tier limits aren't directly queryable via
the API the way "tokens remaining" would need).
