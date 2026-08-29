# Complete Source Code — verbatim, single file

Every source file from the working app, concatenated in one place so the
whole codebase can be handed over without a multi-file folder. This is a
**literal, unedited copy** of each file (same content as when
`AI_HANDOFF` was written) — not a paraphrase, not a summary. If rebuilding
by hand, recreate this exact directory structure and split each section
below back out into its own file at the path given in its heading:

```
requirements.txt
backend/__init__.py
backend/main.py
backend/services/__init__.py
backend/services/llm.py
backend/services/cache.py
backend/services/diagram.py
backend/services/qa.py
backend/services/imagegen.py
backend/services/widgetgen.py
backend/services/videogen.py
backend/services/quizgen.py
backend/services/summarygen.py
backend/services/transcribe.py   (unused - see 03_DECISIONS.md)
backend/services/enrich.py       (unused - see 03_DECISIONS.md)
frontend/index.html
frontend/style.css
frontend/app.js
```

Fenced code blocks below use **4 backticks** (instead of the usual 3)
specifically because a few of these files contain literal ``` sequences
in their own prompt strings (e.g. "strip \`\`\`json") — a normal 3-backtick
fence would terminate early on those. Keep the 4-backtick fences if you
ever re-split this file; a 3-backtick fence will silently truncate
`diagram.py`, `quizgen.py`, `summarygen.py`, and `widgetgen.py`.

---

## `requirements.txt`

````text
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

````

---

## `backend/__init__.py`

````python

````

---

## `backend/main.py`

````python
"""FastAPI app: live transcript text in -> live growing concept-graph out."""
import asyncio
import os
import pip_system_certs.wrapt_requests  # trust Windows cert store (fixes Avast SSL-scan MITM)
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

load_dotenv()

from backend.services.diagram import extract_flowchart
from backend.services.qa import answer_question
from backend.services.imagegen import generate_image
from backend.services.widgetgen import generate_widget
from backend.services.videogen import generate_video, NeedsProPlanError, VIDEO_DIR
from backend.services.quizgen import generate_quiz, generate_check_question
from backend.services.summarygen import generate_summary

ELEVENLABS_API_KEY = (os.getenv("ELEVENLABS_API_KEY") or "").strip()

app = FastAPI()

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=FRONTEND_DIR, html=True), name="static")
app.mount("/videos", StaticFiles(directory=VIDEO_DIR), name="videos")

EXTRACTION_INTERVAL_SECONDS = 20  # ~3 calls/min: stays well under Gemini free-tier's
# ~10 RPM cap, and under a ~2hr live lecture keeps total calls within the free
# tier's daily request budget (reportedly as low as ~250/day for flash models
# on the free tier as of late-2025 quota cuts).
MAX_BACKOFF_SKIPS = 6  # after an error (e.g. rate-limited), wait up to 6 extra
# cycles (~2 more minutes) before trying again, instead of hammering an API
# that's already saying no.


def _find_node(graph: dict, node_id: str) -> dict | None:
    for n in graph.get("nodes", []):
        if n.get("id") == node_id:
            return n
    return None


@app.websocket("/ws/lecture")
async def lecture_ws(ws: WebSocket):
    await ws.accept()
    state = {
        "transcript": "",
        "last_extracted": "",
        "graph": {"nodes": [], "edges": []},
        # Everything here runs as blocking synchronous Gemini calls on one
        # shared event loop (threads deadlock on this machine - see
        # llm.py/README). A user's button click and the periodic extraction
        # timer therefore genuinely contend for the same execution slot; if
        # the extraction cycle is running (or a prior action still is) when
        # you click, the click just waits. This flag doesn't let the
        # extraction timer skip a cycle it's already mid-call for  - nothing
        # can preempt a call already running - but it stops a NEW extraction
        # cycle from starting while a user action is in flight, so a click
        # made during "listening" doesn't get queued behind a fresh 20s
        # extraction that was about to start anyway.
        "busy": False,
    }
    force_event = asyncio.Event()

    async def handle_node_action(msg: dict, context: str, run, ok_payload):
        """Shared per-node action pattern (ask / generate_image /
        generate_widget): look up the node, run the (blocking) call, reply
        with either a success payload or a node-scoped error the frontend
        can use to reset that specific card's UI instead of hanging."""
        node = _find_node(state["graph"], msg.get("node_id"))
        if not node:
            # include node_id even on this path (not just node["id"], since we
            # have no node) so the frontend can still reset that card's UI -
            # otherwise a request for a node the server doesn't recognize
            # (e.g. after a reconnect) leaves the button stuck "pending" forever.
            await ws.send_json({
                "type": "error", "node_id": msg.get("node_id"), "context": context,
                "message": f"unknown node for {context}",
            })
            return
        state["busy"] = True
        try:
            result = run(node)
            await ws.send_json(ok_payload(node, result))
        except Exception as e:
            await ws.send_json({
                "type": "error", "node_id": node["id"], "context": context,
                "message": f"{context} failed: {str(e)[:200]}",
            })
        finally:
            state["busy"] = False

    async def handle_generate_video(msg: dict):
        """Unlike ask/image/widget, this genuinely runs concurrently rather
        than blocking receive_loop/extraction_loop - video generation is a
        multi-minute poll, and holding the whole app hostage for that long
        would be far worse than the brief blocking calls elsewhere. Spawned
        via asyncio.create_task below (fire-and-forget from the caller's
        side), so a user can navigate away, keep talking, or trigger other
        actions while a video renders in the background."""
        node = _find_node(state["graph"], msg.get("node_id"))
        if not node:
            await ws.send_json({
                "type": "error", "node_id": msg.get("node_id"), "context": "generate_video",
                "message": "unknown node for generate_video",
            })
            return
        if not ELEVENLABS_API_KEY:
            await ws.send_json({
                "type": "error", "node_id": node["id"], "context": "generate_video",
                "message": "No ElevenLabs API key configured.",
            })
            return
        try:
            filename, cached = await generate_video(
                node["label"], node.get("definition", ""), ELEVENLABS_API_KEY, force=msg.get("force", False)
            )
            await ws.send_json({
                "type": "video", "node_id": node["id"], "video_url": f"/videos/{filename}", "cached": cached,
            })
        except NeedsProPlanError as e:
            await ws.send_json({
                "type": "error", "node_id": node["id"], "context": "generate_video",
                "message": str(e), "needs_pro": True,
            })
        except Exception as e:
            await ws.send_json({
                "type": "error", "node_id": node["id"], "context": "generate_video",
                "message": f"video generation failed: {str(e)[:200]}",
            })

    async def receive_loop():
        while True:
            msg = await ws.receive_json()
            msg_type = msg.get("type")

            if msg_type == "ask":
                await handle_node_action(
                    msg, "ask",
                    run=lambda node: answer_question(node["label"], node.get("definition", ""), msg.get("question", "")),
                    ok_payload=lambda node, answer: {
                        "type": "answer", "node_id": node["id"],
                        "question": msg.get("question", ""), "answer": answer,
                    },
                )
                continue

            if msg_type == "generate_image":
                await handle_node_action(
                    msg, "generate_image",
                    run=lambda node: generate_image(node["label"], node.get("definition", ""), force=msg.get("force", False)),
                    ok_payload=lambda node, result: {
                        "type": "image", "node_id": node["id"], "image_base64": result[0], "cached": result[1],
                    },
                )
                continue

            if msg_type == "generate_widget":
                await handle_node_action(
                    msg, "generate_widget",
                    run=lambda node: generate_widget(node["label"], node.get("definition", ""), force=msg.get("force", False)),
                    ok_payload=lambda node, result: {
                        "type": "widget", "node_id": node["id"], "html": result[0], "cached": result[1],
                    },
                )
                continue

            if msg_type == "generate_video":
                asyncio.create_task(handle_generate_video(msg))
                continue

            if msg_type == "generate_check":
                await handle_node_action(
                    msg, "generate_check",
                    run=lambda node: generate_check_question(node["label"], node.get("definition", "")),
                    ok_payload=lambda node, question: {
                        "type": "check_question", "node_id": node["id"], "question": question,
                    },
                )
                continue

            if msg_type == "generate_quiz":
                state["busy"] = True
                try:
                    questions = generate_quiz(state["graph"])
                    await ws.send_json({"type": "quiz", "questions": questions})
                except Exception as e:
                    await ws.send_json({"type": "error", "context": "generate_quiz", "message": f"quiz generation failed: {str(e)[:200]}"})
                finally:
                    state["busy"] = False
                continue

            if msg_type == "generate_summary":
                state["busy"] = True
                try:
                    summary = generate_summary(state["graph"])
                    await ws.send_json({"type": "summary", "summary": summary})
                except Exception as e:
                    await ws.send_json({"type": "error", "context": "generate_summary", "message": f"summary generation failed: {str(e)[:200]}"})
                finally:
                    state["busy"] = False
                continue

            # default: transcript update (existing behavior, no explicit type needed)
            state["transcript"] = msg.get("text", state["transcript"])
            if msg.get("force"):
                force_event.set()

    async def run_extraction(transcript: str) -> bool:
        """Returns True on success, False on error (caller uses this to back off)."""
        state["last_extracted"] = transcript
        try:
            graph = extract_flowchart(transcript, state["graph"])
        except Exception as e:
            await ws.send_json({"type": "error", "message": str(e)[:300]})
            return False
        state["graph"] = graph
        if graph.get("nodes"):
            await ws.send_json({"type": "diagram", "data": graph})
        else:
            await ws.send_json({"type": "empty"})
        return True

    async def extraction_loop():
        backoff_skips_remaining = 0
        while True:
            forced = False
            try:
                await asyncio.wait_for(force_event.wait(), timeout=EXTRACTION_INTERVAL_SECONDS)
                forced = True
            except asyncio.TimeoutError:
                pass
            force_event.clear()

            transcript = state["transcript"]
            if not transcript:
                continue

            if state["busy"] and not forced:
                continue  # a user action (ask/image/widget) is running - don't queue behind it

            if backoff_skips_remaining > 0 and not forced:
                backoff_skips_remaining -= 1
                continue

            if not forced and transcript == state["last_extracted"]:
                continue  # nothing new since last pass, skip the Gemini call

            state["busy"] = True
            try:
                ok = await run_extraction(transcript)
            finally:
                state["busy"] = False
            backoff_skips_remaining = 0 if ok else MAX_BACKOFF_SKIPS

    try:
        await asyncio.gather(receive_loop(), extraction_loop())
    except WebSocketDisconnect:
        pass

````

---

## `backend/services/__init__.py`

````python

````

---

## `backend/services/llm.py`

````python
"""Shared Gemini call helper.

Different Gemini model names draw from SEPARATE free-tier quota pools (learned
the hard way mid-demo: gemini-3.6-flash ran out, lite/latest variants didn't).
Every text-generating feature (diagram extraction, Q&A) goes through this so
they all get the same automatic fallback instead of each reimplementing it.
"""
import os
import google.generativeai as genai

genai.configure(api_key=os.getenv("GEMINI_API_KEY"), transport="rest")

MODEL_FALLBACK_CHAIN = [
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
]

_model_cache = {}
_working_model_index = 0  # sticky: once one works, start there next time


def _get_model(name: str, system_instruction: str):
    key = (name, system_instruction)
    if key not in _model_cache:
        _model_cache[key] = genai.GenerativeModel(name, system_instruction=system_instruction)
    return _model_cache[key]


def generate_with_fallback(prompt: str, system_instruction: str, timeout: int = 15, json_mode: bool = False) -> str:
    global _working_model_index
    last_error = None
    gen_config = genai.GenerationConfig(response_mime_type="application/json") if json_mode else None
    order = list(range(_working_model_index, len(MODEL_FALLBACK_CHAIN))) + list(range(_working_model_index))
    for i in order:
        name = MODEL_FALLBACK_CHAIN[i]
        try:
            model = _get_model(name, system_instruction)
            response = model.generate_content(
                prompt, request_options={"timeout": timeout}, generation_config=gen_config
            )
        except Exception as e:
            last_error = e
            continue
        _working_model_index = i
        return response.text or ""
    raise last_error

````

---

## `backend/services/cache.py`

````python
"""Persistent, on-disk cache for generated widgets/images, keyed by a
normalized concept label.

The point: infinite variety (any concept gets a bespoke widget) genuinely
needs one LLM call per NEW concept - there's no way around that. But
lecture topics repeat constantly (gradient descent, recursion, linear
regression...), so caching by concept makes almost every REPEAT view free
and instant, which is what actually makes it feel unlimited rather than
rate-limited. Survives server restarts (plain JSON files, not per-connection
state) so the cache only ever grows across every lecture ever run here.
"""
import json
import re
from pathlib import Path
from threading import Lock

CACHE_DIR = Path(__file__).parent.parent.parent / "data"
CACHE_DIR.mkdir(exist_ok=True)

_lock = Lock()  # single-process, single-writer-at-a-time is enough here


def _slug(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "unnamed"


def _cache_path(cache_name: str) -> Path:
    return CACHE_DIR / f"{cache_name}_cache.json"


def _load(cache_name: str) -> dict:
    path = _cache_path(cache_name)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def get_cached(cache_name: str, label: str):
    with _lock:
        return _load(cache_name).get(_slug(label))


def set_cached(cache_name: str, label: str, value) -> None:
    with _lock:
        data = _load(cache_name)
        data[_slug(label)] = value
        _cache_path(cache_name).write_text(json.dumps(data), encoding="utf-8")

````

---

## `backend/services/diagram.py`

````python
"""LLM: turn a running transcript into a growing, structured concept graph.

Key design: the model is fed the graph it already produced (compact form —
ids/labels/categories only) and asked to return the FULL updated graph,
reusing existing ids rather than inventing new ones for the same concept.
That's what lets the diagram grow without ever deleting anything. As a
safety net (never rely on the model's obedience alone for something this
testable), extract_flowchart() also mechanically re-adds any existing node
the model's response fails to carry forward, and preserves each existing
node's stored fields (definition/steps/etc.) rather than trusting the model
to reproduce them identically every call.
"""
import json
from backend.services.llm import generate_with_fallback

SYSTEM = """You read a running lecture transcript and build a growing concept
map of the material worth diagramming - the parts that are hard, confusing,
or conceptually central. Output STRICT JSON only, no markdown fences, no
commentary:

{
  "nodes": [
    {
      "id": "short_snake_case_id",
      "label": "short label, <=4 words",
      "analogy": "1 short sentence: explain this concept via a everyday,
        relatable comparison a total beginner would already understand
        (e.g. 'A stack is like a pile of plates - you can only take from
        or add to the top.'). This is the FIRST thing the student reads,
        before the formal definition - make it genuinely click, not just
        restate the definition in different words.",
      "definition": "1-3 sentences, fuller/more precise explanation after the analogy",
      "category": "one short lowercase word for color-coding, e.g. math, code, process, theory, warning, definition",
      "mode": "definition" | "steps" | "interactive",
      "steps": [{"label": "short step name", "detail": "1 sentence"}]
    }
  ],
  "edges": [{"from": "id", "to": "id", "label": "short relation, e.g. feeds into"}]
}

`mode` is YOU choosing the best way to explain this specific concept to a
student - pick per node, don't default to one mode for everything:
- "definition": a static idea best explained by a short definition alone
  (most concepts). Omit "steps".
- "steps": a multi-step PROCESS worth animating step by step (e.g.
  backpropagation, gradient descent, recursion unwinding, a sort algorithm).
  Include an ordered "steps" array.
- "interactive": a concept a student would learn best by actually poking at
  it with their own inputs (e.g. a Turing machine, a state machine, a
  parser, a data structure operation). Include "steps" too if it has a
  natural step sequence, it's optional otherwise.

You will be given the nodes ALREADY on the map (id/label/category/mode) -
reuse those exact ids for anything already covered, do not redefine or
duplicate them, only add NEW nodes/edges for genuinely new content in this
transcript chunk. Keep new nodes to a handful per call. If nothing new/hard
yet, return {"nodes": [], "edges": []}.
"""


def _compact(graph: dict) -> list:
    return [
        {"id": n["id"], "label": n["label"], "category": n.get("category"), "mode": n.get("mode")}
        for n in graph.get("nodes", [])
    ]


def _dedupe_edges(edges: list) -> list:
    seen = {}
    for e in edges:
        key = (e.get("from"), e.get("to"))
        if key not in seen:
            seen[key] = e
    return list(seen.values())


def _normalize_node(n: dict) -> dict:
    """`json_mode=True` only guarantees syntactically valid JSON, not that the
    model actually followed the mode/steps contract - seen in practice: a
    node tagged mode="steps" with no "steps" array at all, which renders a
    Play button that silently does nothing when clicked. Self-heal instead
    of trusting prompt compliance for something this checkable."""
    if n.get("mode") in ("steps", "interactive") and not n.get("steps"):
        n["mode"] = "definition"
    return n


def extract_flowchart(transcript_so_far: str, existing_graph: dict) -> dict:
    prompt = (
        f"ALREADY ON THE MAP (reuse these ids, don't redefine):\n"
        f"{json.dumps(_compact(existing_graph))}\n\n"
        f"TRANSCRIPT:\n{transcript_so_far[-4000:]}"
    )
    text = generate_with_fallback(prompt, SYSTEM, timeout=15, json_mode=True)
    text = text.strip().strip("```json").strip("```")  # belt-and-suspenders even with json_mode
    try:
        new_graph = json.loads(text)
    except json.JSONDecodeError:
        new_graph = {"nodes": [], "edges": []}

    # Merge: stable ids keep their ALREADY-STORED fields (don't let the model
    # silently rewrite a definition differently each call); genuinely new ids
    # use whatever the model just produced. Any existing node the model
    # forgot to re-list still gets carried forward - "never delete" is
    # enforced here mechanically, not just by prompt instruction.
    existing_by_id = {n["id"]: n for n in existing_graph.get("nodes", [])}
    merged_nodes = []
    seen_ids = set()
    for n in new_graph.get("nodes", []):
        node_id = n.get("id")
        if not node_id:
            continue
        if node_id in existing_by_id:
            merged_nodes.append(existing_by_id[node_id])
        else:
            merged_nodes.append(_normalize_node(n))
        seen_ids.add(node_id)
    for node_id, n in existing_by_id.items():
        if node_id not in seen_ids:
            merged_nodes.append(n)

    merged_edges = _dedupe_edges(existing_graph.get("edges", []) + new_graph.get("edges", []))

    return {"nodes": merged_nodes, "edges": merged_edges}

````

---

## `backend/services/qa.py`

````python
"""LLM: answer a student's follow-up question about one specific concept."""
from backend.services.llm import generate_with_fallback

SYSTEM = """You are a concise, patient tutor helping a student who is live in
a lecture right now. You'll be given one concept from their notes and a
question about it. Answer in 2-4 short sentences, plain language, no
markdown formatting, no headers - this renders in a small card on their
screen while the lecture keeps going, so be direct and readable at a
glance."""


def answer_question(node_label: str, node_definition: str, question: str) -> str:
    prompt = (
        f"Concept: {node_label}\n"
        f"Definition on their card: {node_definition}\n\n"
        f"Student's question: {question}"
    )
    return generate_with_fallback(prompt, SYSTEM, timeout=15).strip()

````

---

## `backend/services/imagegen.py`

````python
"""On-demand image generation for a single concept card.

User-triggered only (never called from the extraction timer) - keeps API
cost bounded to the user's own clicks. Tries a chain of image-capable Gemini
models for the same reason the text chain exists: separate free-tier quota
pools, so one model being tapped out doesn't kill the feature.

Verified against the actually-installed `google-generativeai` package
(not just docs, which have moved on to the new `google-genai` SDK):
- `response.candidates[0].content.parts[i].inline_data.data` is already raw
  bytes (NOT base64) - do not b64decode it, only b64encode for the frontend.
- `generation_config={"response_modalities": ["TEXT", "IMAGE"]}` must be
  passed as a plain dict (the `genai.GenerationConfig` dataclass doesn't
  declare this field in this package version and raises TypeError; a plain
  dict bypasses that validation and reaches the proto correctly).
- "nano-banana-pro-preview" is a marketing nickname, not a real API model
  id - the real ids are gemini-3.1-flash-image ("Nano Banana 2", most
  likely to still be free-tier) and gemini-3-pro-image(-preview) (reported
  to require billing, so listed last / as a long-shot fallback).
"""
import base64
import os
import google.generativeai as genai
from backend.services.cache import get_cached, set_cached

genai.configure(api_key=os.getenv("GEMINI_API_KEY"), transport="rest")

CACHE_NAME = "images"

IMAGE_MODEL_CHAIN = [
    "gemini-3.1-flash-image",
    "gemini-3-pro-image-preview",
    "gemini-3-pro-image",
]

PROMPT_TEMPLATE = (
    "A simple, clean, colorful educational illustration of this concept: "
    "{label}. {definition} Flat design, minimal, no text/words/labels "
    "rendered in the image itself, plain light background, suitable as a "
    "small icon-like illustration on a study flashcard."
)


def generate_image(label: str, definition: str = "", force: bool = False) -> tuple[str, bool]:
    """Returns (base64_image, was_cached). Same concept -> same cached image
    forever unless force=True. Given today's image-model quota was
    completely exhausted by testing, this cache is what makes the feature
    usable again at all for any concept seen before, at zero further cost."""
    if not force:
        cached = get_cached(CACHE_NAME, label)
        if cached:
            return cached, True

    prompt = PROMPT_TEMPLATE.format(label=label, definition=definition or "")
    last_error = None
    for name in IMAGE_MODEL_CHAIN:
        try:
            model = genai.GenerativeModel(name)
            response = model.generate_content(
                prompt,
                request_options={"timeout": 30},
                generation_config={"response_modalities": ["TEXT", "IMAGE"]},
            )
            for part in response.candidates[0].content.parts:
                inline = getattr(part, "inline_data", None)
                if inline and inline.data:
                    b64 = base64.b64encode(inline.data).decode("utf-8")
                    set_cached(CACHE_NAME, label, b64)
                    return b64, False
        except Exception as e:
            last_error = e
            continue
    raise last_error or RuntimeError("no image model in the chain produced image data")

````

---

## `backend/services/widgetgen.py`

````python
"""Generate a self-contained, interactive HTML/JS simulation for one concept.

User-triggered only (a button per node), same bounded-cost pattern as image
generation - but this uses the regular TEXT model chain (llm.py), not the
image-gen chain, so it's cheap and draws from the quota pool that's actually
working today. Rendered client-side in a sandboxed iframe (see frontend
app.js) - `sandbox="allow-scripts"` with NO `allow-same-origin`, loaded via
`srcdoc`, plus a CSP meta tag injected server-side (defense in depth against
network exfiltration, which `sandbox` alone doesn't block).

Prompting approach (researched): raw HTML only, single self-contained file,
zero external dependencies, a required-controls list, and hard safety bans
restated at the end (late instructions get weighted more heavily) - no
unbounded loops, every timer must have a working stop condition, wrap
everything in try/catch + a window.onerror fallback.
"""
import re
from backend.services.llm import generate_with_fallback
from backend.services.cache import get_cached, set_cached

CACHE_NAME = "widgets"

SYSTEM = """You write a single self-contained interactive educational HTML
widget that lets a student directly manipulate a concept from their lecture
to understand it - not a static diagram, an actual small simulation/toy they
can play with (add points, drag sliders, click to step through, type inputs
and see results). Think "a tiny interactive explainer a student could poke
at for two minutes and genuinely get it."

OUTPUT CONTRACT: output ONLY the raw HTML document, starting with
<!DOCTYPE html> and ending with </html>. No markdown fences, no commentary
before or after.

STRUCTURE: one <style> block in <head>, one <script> block before </body>.
Vanilla JS and CSS/SVG/Canvas only.

ZERO EXTERNAL DEPENDENCIES: no <script src> or <link> to any external
domain, no web fonts, no external images/audio/video. System font stack
only. Build any visuals with CSS, inline SVG, or Canvas 2D drawing calls.

REQUIRED: at least 2-3 real interactive controls appropriate to the concept
(buttons, sliders, click-to-add-a-point, text inputs, step forward/back) and
a visible readout of current state that updates as the student interacts.
Make it genuinely playable, not a single button that does one thing once -
this is the whole point, favor MORE interactivity over a simpler widget.

Examples of the bar to hit:
- Linear regression: click to add data points on a canvas, a line re-fits
  live, show the equation/error updating.
- A sorting algorithm: array of bars, step/play controls, current
  comparison highlighted, editable input array.
- A Turing machine / state machine: an input field, step button showing
  head position and state transition, a visible tape/state diagram.
- Gradient descent: a slider for learning rate, click to place a starting
  point, step button shows it moving down a loss curve.

HARD SAFETY BANS (do not violate any of these):
- No `while(true)` or any loop without a guaranteed-terminating condition.
- Any `setInterval`/animation loop must have a working Pause/Stop control
  and must actually stop when clicked - never leave a runaway timer.
- Wrap all script logic in try/catch; also set `window.onerror` to show a
  visible small error message in the page instead of a silent blank widget.
- No `fetch`, `XMLHttpRequest`, `WebSocket`, or `import` of any kind.
- Keep it compact - roughly 100-250 lines total. A smaller, fully-working
  widget beats a larger broken one.
"""

_CSP_META = (
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
    "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; "
    "font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; "
    "base-uri 'none'\">"
)

# Reports the widget's real content height to the parent page so the iframe
# can be sized to fit instead of guessing a fixed pixel height (the "so
# small, make it fit" feedback). CSP's connect-src doesn't govern
# postMessage, so this isn't blocked by the CSP above. The iframe's origin
# is opaque under sandbox="allow-scripts" (no allow-same-origin) - postMessage
# has to target '*' since the child can't know a real parent origin, and the
# parent must validate via event.source, not event.origin (which is always
# the literal string "null" for an opaque origin, not "unset"/omittable).
_RESIZE_SCRIPT = """
<script>
new ResizeObserver(() => {
  parent.postMessage({ __widgetResize: true, height: document.documentElement.scrollHeight }, '*');
}).observe(document.documentElement);
</script>
"""


def _inject_csp(html: str) -> str:
    """Defense-in-depth: sandbox doesn't block outbound network calls, a CSP
    with connect-src 'none' does. Inject regardless of whether the model
    remembered to (it wasn't even asked to - this is enforced server-side,
    not trusted to prompt compliance)."""
    if "<head>" in html:
        html = html.replace("<head>", f"<head>{_CSP_META}", 1)
    elif "<html>" in html:
        html = html.replace("<html>", f"<html><head>{_CSP_META}</head>", 1)
    else:
        html = _CSP_META + html  # no <head>/<html> at all - prepend as a last resort

    if "</body>" in html:
        html = html.replace("</body>", f"{_RESIZE_SCRIPT}</body>", 1)
    else:
        html += _RESIZE_SCRIPT
    return html


def generate_widget(label: str, definition: str, force: bool = False) -> tuple[str, bool]:
    """Returns (html, was_cached). Same concept label -> same cached widget
    forever (across restarts, across every lecture), unless force=True (the
    explicit Regenerate button), which always calls the model and
    overwrites the cache with the fresh result."""
    if not force:
        cached = get_cached(CACHE_NAME, label)
        if cached:
            return cached, True

    prompt = f"Concept: {label}\nDefinition: {definition}\n\nBuild the interactive widget now."
    # 18s/model, not 25s: a real successful call took 12.6s in testing, and
    # everything here blocks the whole shared event loop (see main.py) - a
    # tighter per-model timeout bounds the worst case across the fallback
    # chain (was up to 100s across 4 models) without cutting into the
    # margin a genuine slow-but-working call actually needs.
    html = generate_with_fallback(prompt, SYSTEM, timeout=18)
    html = html.strip()
    html = re.sub(r"^```(?:html)?\s*", "", html)
    html = re.sub(r"```\s*$", "", html).strip()
    html = _inject_csp(html)
    set_cached(CACHE_NAME, label, html)
    return html, False

````

---

## `backend/services/videogen.py`

````python
"""On-demand short teaching video per concept, via ElevenLabs' async Flows
video API.

STATUS: built and wired end-to-end against ElevenLabs' documented API
contract, but the actual generation call is CONFIRMED BLOCKED on the
current free-tier key - a live test returned:
    402 Payment Required: "This endpoint requires a Pro plan or above."
This is ready to go the moment the key is upgraded (hackathon day) - no
further code changes should be needed, just a working key. Everything
EXCEPT the actual successful generation has been exercised: the 402 error
path is real and tested, the request/response shapes match ElevenLabs'
current docs (POST /v1/flows/video -> {id, status}; GET
/v1/flows/video/{id} -> pending/generating/completed/failed, completed
carries a content_url that expires ~1hr after the response).

Architecture note: video generation is a multi-minute POLLING operation.
Every other Gemini-backed service in this app calls a blocking synchronous
client because threads deadlock here (see llm.py/README - a Windows
cert-store quirk under this machine's Avast-MITM setup). A multi-minute
BLOCKING call would freeze the entire single-threaded app for everyone for
that whole window. Fixed for this service specifically by using `httpx`'s
async client (genuine non-blocking I/O on the existing event loop, no
extra OS thread) with `truststore` patched in for the same cert-trust fix,
verified independently to work for this async client too.
"""
import asyncio
import time
from pathlib import Path

import httpx
import truststore

from backend.services.llm import generate_with_fallback

truststore.inject_into_ssl()

VIDEO_DIR = Path(__file__).parent.parent.parent / "data" / "videos"
VIDEO_DIR.mkdir(parents=True, exist_ok=True)

BASE_URL = "https://api.elevenlabs.io/v1/flows/video"
POLL_INTERVAL_SECONDS = 4
MAX_POLL_ATTEMPTS = 75  # ~5 minutes ceiling

VIDEO_PROMPT_SYSTEM = """You write a short, focused prompt for an AI VIDEO
generator that will create a brief educational clip explaining ONE concept
for a student's flashcard-style video - this is NOT a movie, it's a
minimal, clear, textbook-style visual explanation meant to teach fast.

Output ONLY the video generation prompt text itself (1-2 sentences), no
preamble, no quotes marks, no explanation of your choice.

Requirements for the prompt you write:
- Describes a simple, clean, minimal animated visual (like a whiteboard
  diagram animating itself), not a cinematic scene - no actors, no
  dialogue, no camera moves, no background music cues
- Focuses on ONE clear visual metaphor or process that actually teaches
  the concept, not a vague mood shot
- Explicitly include the phrase "no on-screen text or captions" (video
  models render text badly and it looks broken)
- Be concrete and visual: describe shapes, motion, and what changes, e.g.
  "a straight line on a 2D graph rotates and shifts smoothly to minimize
  its distance to a cluster of scattered red dots" rather than an abstract
  description of the concept
"""


class NeedsProPlanError(Exception):
    """Raised when ElevenLabs returns 402 - the account's plan doesn't
    include API video generation. Distinct from other failures so the
    frontend can show a specific, actionable message instead of a generic
    error."""


def _slug(label: str) -> str:
    import re
    return re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "unnamed"


def _cached_path(label: str) -> Path:
    return VIDEO_DIR / f"{_slug(label)}.mp4"


async def generate_video(label: str, definition: str, api_key: str, force: bool = False) -> tuple[str, bool]:
    """Returns (filename_relative_to_VIDEO_DIR, was_cached). Raises
    NeedsProPlanError on 402, or a generic Exception for any other failure."""
    cached = _cached_path(label)
    if not force and cached.exists():
        return cached.name, True

    # Gemini (cheap, already reliable) writes the actual video prompt - a
    # short, teaching-focused visual description - rather than trusting the
    # raw concept label/definition directly, which tends to produce vaguer
    # or more "cinematic" results from video models.
    video_prompt = generate_with_fallback(
        f"Concept: {label}\nDefinition: {definition}", VIDEO_PROMPT_SYSTEM, timeout=15
    ).strip()

    headers = {"xi-api-key": api_key, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=20) as client:
        create_resp = await client.post(
            BASE_URL,
            headers=headers,
            json={
                "model_id": "veo-3.1-generate-001",
                "prompt": video_prompt,
                "duration_secs": 8,  # shortest practical clip - "teach fast", not a movie
                "generate_audio": False,  # keep it purely visual, no narration to manage
            },
        )
        if create_resp.status_code == 402:
            raise NeedsProPlanError("ElevenLabs video generation requires a Pro plan or above.")
        create_resp.raise_for_status()
        generation_id = create_resp.json()["id"]

        for _ in range(MAX_POLL_ATTEMPTS):
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
            poll_resp = await client.get(f"{BASE_URL}/{generation_id}", headers=headers)
            poll_resp.raise_for_status()
            data = poll_resp.json()
            status = data.get("status")

            if status == "completed":
                video_resp = await client.get(data["content_url"], timeout=60)
                video_resp.raise_for_status()
                cached.write_bytes(video_resp.content)
                return cached.name, False

            if status == "failed":
                raise RuntimeError(data.get("error_message", "video generation failed"))

    raise TimeoutError("video generation did not complete within the polling window")

````

---

## `backend/services/quizgen.py`

````python
"""Auto-generated quiz over the whole concept map so far.

One batch call covering everything on the map - cheap regardless of how
many concepts have accumulated, since it's a single request either way.
Not cached (unlike widgets/images/definitions): the map keeps growing
through a lecture, so a quiz generated now should reflect what's actually
on the map at the moment you ask, not a stale snapshot from earlier.
"""
import json
from backend.services.llm import generate_with_fallback

SYSTEM = """You write a short multiple-choice quiz testing understanding of
a set of lecture concepts. Output STRICT JSON only, no markdown fences, no
commentary:

{
  "questions": [
    {
      "question": "the question text",
      "options": ["option A", "option B", "option C", "option D"],
      "correct_index": 0,
      "explanation": "1 sentence: why that's correct, said directly to the student"
    }
  ]
}

Write 5-8 questions (fewer if there genuinely aren't many concepts to test -
never pad with trivial or repetitive questions). Cover a SPREAD of the
concepts given, not just the first few. Questions should test real
understanding (apply/compare/explain-why), not just "what's the definition
of X verbatim" recall. Exactly 4 options per question, exactly one correct.
Keep both questions and options short enough to read at a glance.
"""


def generate_quiz(graph: dict) -> list:
    concepts = [
        {"label": n.get("label"), "definition": n.get("definition")}
        for n in graph.get("nodes", [])
        if n.get("definition")
    ]
    if not concepts:
        return []

    prompt = f"Concepts covered so far:\n{json.dumps(concepts)}\n\nWrite the quiz now."
    text = generate_with_fallback(prompt, SYSTEM, timeout=20, json_mode=True)
    text = text.strip().strip("```json").strip("```")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return []

    # Defensive: drop any malformed question rather than let one bad entry
    # break the whole quiz UI.
    questions = []
    for q in data.get("questions", []):
        opts = q.get("options")
        idx = q.get("correct_index")
        if q.get("question") and isinstance(opts, list) and len(opts) == 4 and isinstance(idx, int) and 0 <= idx < 4:
            questions.append(q)
    return questions


CHECK_SYSTEM = """You write ONE multiple-choice active-recall question
checking whether a student who just interacted with an INTERACTIVE
SIMULATION of a concept actually understood what they saw - not a generic
definition question, one that specifically probes the behavior/mechanism
the simulation demonstrates (e.g. "what would happen if you doubled X?",
"what causes Y to happen in this process?"). Output STRICT JSON only, no
markdown fences, no commentary:

{
  "question": "the question text",
  "options": ["option A", "option B", "option C", "option D"],
  "correct_index": 0,
  "explanation": "1 sentence: why that's correct, said directly to the student"
}

Exactly 4 options, exactly one correct. Keep both short enough to read at a
glance - this appears right after they close the simulation, don't make
them re-read a wall of text.
"""


def generate_check_question(label: str, definition: str) -> dict | None:
    prompt = f"Concept: {label}\nDefinition: {definition}\n\nWrite the check question now."
    text = generate_with_fallback(prompt, CHECK_SYSTEM, timeout=15, json_mode=True)
    text = text.strip().strip("```json").strip("```")
    try:
        q = json.loads(text)
    except json.JSONDecodeError:
        return None
    opts = q.get("options")
    idx = q.get("correct_index")
    if q.get("question") and isinstance(opts, list) and len(opts) == 4 and isinstance(idx, int) and 0 <= idx < 4:
        return q
    return None

````

---

## `backend/services/summarygen.py`

````python
"""End-of-lecture wrap-up: a short bullet-point summary of everything on the
map, generated in one batch call (cheap regardless of map size). Purely a
read-only view - generating it never touches the graph, so the live
mind-map keeps working exactly as before after you close it (more
concepts, more simulations, another quiz - nothing is disabled)."""
import json
from backend.services.llm import generate_with_fallback

SYSTEM = """You write a short wrap-up summary of a lecture, given the
concepts extracted from it so far. Output STRICT JSON only, no markdown
fences, no commentary:

{
  "title": "a short session title, <=6 words",
  "bullets": ["bullet point 1", "bullet point 2", ...]
}

Write 4-8 bullets. Each bullet is ONE short sentence capturing a real idea
or connection from the material - not just a restated list of concept
names. Where relevant, connect related concepts in a single bullet rather
than one bullet per concept. Write for a student reviewing what they just
learned, plain and direct.
"""


def generate_summary(graph: dict) -> dict | None:
    concepts = [
        {"label": n.get("label"), "definition": n.get("definition"), "category": n.get("category")}
        for n in graph.get("nodes", [])
        if n.get("definition")
    ]
    if not concepts:
        return None

    prompt = f"Concepts covered:\n{json.dumps(concepts)}\n\nWrite the wrap-up now."
    text = generate_with_fallback(prompt, SYSTEM, timeout=20, json_mode=True)
    text = text.strip().strip("```json").strip("```")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None

    if not data.get("bullets"):
        return None
    return {"title": data.get("title") or "Lecture wrap-up", "bullets": data["bullets"]}

````

---

## `backend/services/transcribe.py`

````python
"""ElevenLabs speech-to-text wrapper."""
import os
from elevenlabs.client import ElevenLabs

client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))


def transcribe_chunk(audio_bytes: bytes) -> str:
    """Send one audio chunk to ElevenLabs Scribe, return text."""
    result = client.speech_to_text.convert(
        file=audio_bytes,
        model_id="scribe_v1",
    )
    return result.text or ""

````

---

## `backend/services/enrich.py`

````python
"""Tavily: add a one-line real-world example/definition to a node."""
import os
from tavily import TavilyClient

client = TavilyClient(api_key=os.getenv("TAVILY_API_KEY"))


def enrich_label(label: str) -> str:
    """Return a short explanation string for a diagram node label."""
    res = client.search(query=f"explain simply: {label}", max_results=1)
    if res.get("results"):
        return res["results"][0].get("content", "")[:200]
    return ""

````

---

## `frontend/index.html`

````html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Lecture → Mind Map</title>
<link rel="stylesheet" href="style.css">
<!-- d3-force's standalone UMD bundle doesn't actually include its d3-timer
     dependency (verified: throws "r.timer is not a function" at runtime) -
     using the full d3 bundle instead, which is guaranteed complete. -->
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
</head>
<body>

<div id="topbar">
  <h1>🎓 Lecture → Living Mind-Map</h1>
  <div class="controls">
    <button id="startBtn">▶ Start listening</button>
    <button id="wrapupBtn">🎁 Wrap up</button>
    <button id="fitViewBtn">🔍 Fit to view</button>
    <button id="quizBtn">📝 Quiz me</button>
  </div>
  <p id="status">idle</p>
  <div id="collapsibles">
    <div class="panel-box">
      <label>Live transcript</label>
      <div id="transcript"></div>
    </div>
    <div class="panel-box">
      <label>No mic, or recognition not picking up? Type/paste lecture text here — feeds the same pipeline.</label>
      <textarea id="manualInput" placeholder="Paste or type lecture text here..."></textarea>
    </div>
  </div>
</div>

<div id="main">
  <div id="viewport">
    <div id="canvas">
      <svg id="edgeLayer">
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="currentColor" style="fill: var(--muted, #888)"></path>
          </marker>
        </defs>
      </svg>
    </div>
    <div class="placeholder-hint" id="placeholderHint">
      Nothing on the map yet — start listening or paste some lecture text.
      Concepts will appear here and grow as the lecture continues.
    </div>
  </div>

  <div id="panel">
    <div class="panel-hint">Click a concept on the map to explore it here.</div>
  </div>
</div>

<div id="simOverlay">
  <div class="sim-overlay-box">
    <div class="sim-overlay-header">
      <h3 id="simOverlayTitle">Simulation</h3>
      <button id="simOverlayClose">✕ Close</button>
    </div>
  </div>
</div>

<div id="quizOverlay">
  <div class="sim-overlay-box quiz-box">
    <div class="sim-overlay-header">
      <h3>Quiz</h3>
      <button id="quizOverlayClose">✕ Close</button>
    </div>
    <div id="quizContent"></div>
  </div>
</div>

<div id="wrapupOverlay">
  <div class="wrapup-page">
    <button id="wrapupClose" class="wrapup-close">✕ Close &amp; keep going</button>
    <div id="wrapupContent"></div>
  </div>
</div>

<div id="toastContainer"></div>

<script src="app.js"></script>
</body>
</html>

````

---

## `frontend/style.css`

````css
:root {
  color-scheme: light dark;
  --bg: #f3f4f6;
  --panel: #ffffff;
  --text: #1a1a1a;
  --muted: #6b7280;
  --border: #e0e0e0;
  --accent: #2e7d32;
  --err: #c62828;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181d;
    --panel: #23262d;
    --text: #eee;
    --muted: #9aa0a6;
    --border: #3a3d44;
    --accent: #4caf50;
    --err: #ef5350;
  }
}

* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; height: 100%; overflow: hidden;
  font-family: -apple-system, Segoe UI, Roboto, sans-serif;
  background: var(--bg); color: var(--text);
  display: flex; flex-direction: column;
}

/* #topbar's real height varies (controls/transcript boxes can wrap taller
   on some window sizes) - it used to be `position: fixed` with #main
   hardcoded to `top: 90px`, which silently hid the panel's top content
   *behind* the opaque topbar whenever the topbar was actually taller than
   90px. Flex layout instead: topbar sized to its own content, #main takes
   the rest - no guessed pixel offset to go stale. */
#topbar {
  flex-shrink: 0; z-index: 50;
  background: var(--panel); border-bottom: 1px solid var(--border);
  padding: 0.7rem 1rem; display: flex; flex-direction: column; gap: 0.5rem;
}
#topbar h1 { margin: 0; font-size: 1.1rem; }
.controls { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
button {
  font-size: 0.9rem; padding: 0.45rem 0.9rem; border-radius: 8px;
  border: 1px solid var(--border); cursor: pointer; background: var(--bg); color: var(--text);
}
button:hover { filter: brightness(1.1); }
button:disabled { opacity: 0.5; cursor: default; }
#startBtn.active { background: var(--accent); color: white; border-color: var(--accent); }
#status { font-weight: 600; font-size: 0.85rem; margin: 0; }
#status.err { color: var(--err); }
#status.ok { color: var(--accent); }

#collapsibles { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: flex-start; }
.panel-box {
  flex: 1; min-width: 220px; max-width: 420px;
  border: 1px solid var(--border); border-radius: 8px; padding: 0.4rem 0.6rem;
  background: var(--bg); font-size: 0.78rem;
}
.panel-box label { display: block; color: var(--muted); margin-bottom: 0.2rem; font-size: 0.72rem; }
#transcript { max-height: 60px; overflow-y: auto; white-space: pre-wrap; color: var(--muted); }
#manualInput {
  width: 100%; min-height: 42px; font-family: inherit; font-size: 0.78rem;
  border-radius: 6px; border: 1px solid var(--border); padding: 0.3rem 0.5rem;
  resize: vertical; background: var(--panel); color: var(--text);
}

/* ---------- layout: canvas (left) + panel (right) ---------- */
:root { --panel-width: 500px; }
#main { flex: 1; min-height: 0; display: flex; position: relative; }

/* ---------- canvas / pan-zoom ---------- */
#viewport {
  position: relative; flex: 1; min-width: 0;
  overflow: hidden; touch-action: none; cursor: grab;
}
#viewport.dragging { cursor: grabbing; }
#canvas {
  position: absolute; left: 50%; top: 50%; width: 0; height: 0;
  transform-origin: 0 0;
}
#edgeLayer { position: absolute; overflow: visible; pointer-events: none; }
#edgeLayer line { stroke: var(--muted); stroke-width: 2; marker-end: url(#arrowhead); }
#edgeLayer text { fill: var(--muted); font-size: 11px; }

.placeholder-hint {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  color: var(--muted); font-size: 0.95rem; text-align: center; width: 300px;
}

/* ---------- cards ---------- */
.card {
  position: absolute; left: 0; top: 0; width: 190px; height: 110px;
  margin-left: -95px; margin-top: -55px;
  perspective: 900px;
  opacity: 1; transition: opacity 0.5s ease;
}
.card.entering { opacity: 0; }
.card-inner {
  position: relative; width: 100%; height: 100%;
  transform-style: preserve-3d; transition: transform 0.5s;
  cursor: pointer;
}
.card-inner.flipped { transform: rotateY(180deg); }
.card-face {
  position: absolute; inset: 0; backface-visibility: hidden;
  transform: rotateY(0deg); /* defensive no-op: some engines ignore
    backface-visibility on an untransformed child of a preserve-3d parent */
  border-radius: 10px; border: 2px solid var(--card-color, #888);
  background: var(--panel); padding: 0.5rem 0.6rem; overflow: hidden;
  display: flex; flex-direction: column;
  box-shadow: 0 2px 6px rgba(0,0,0,0.15);
}
.card-back { transform: rotateY(180deg); overflow-y: auto; cursor: auto; }
.card-badge {
  display: inline-block; font-size: 0.62rem; text-transform: uppercase;
  letter-spacing: 0.03em; color: white; background: var(--card-color, #888);
  border-radius: 4px; padding: 0.08rem 0.4rem; margin-bottom: 0.3rem; width: fit-content;
}
.card-label { font-weight: 700; font-size: 0.92rem; line-height: 1.2; }
.card-hint { margin-top: auto; font-size: 0.68rem; color: var(--muted); }
.card.selected .card-face { box-shadow: 0 0 0 3px var(--accent); }

.card-definition { font-size: 0.76rem; line-height: 1.3; margin-bottom: 0.35rem; }
.card-error { font-size: 0.78rem; color: var(--err); margin: 0.4rem 0; }

.qa-item { font-size: 0.85rem; margin-bottom: 0.5rem; border-top: 1px dashed var(--border); padding-top: 0.4rem; }
.qa-q { font-weight: 600; }
.qa-a { color: var(--muted); margin-top: 0.15rem; }
.ask-form { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
.ask-form input {
  flex: 1; font-size: 0.85rem; padding: 0.45rem 0.6rem; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text);
}
.ask-form button { font-size: 0.8rem; }

.image-slot { margin-bottom: 0.3rem; }
.image-slot img { max-width: 100%; border-radius: 8px; display: block; }

@media (pointer: coarse) {
  .card { width: 220px; height: 130px; margin-left: -110px; margin-top: -65px; }
}

/* ---------- right panel: the real interaction surface ---------- */
#panel {
  width: var(--panel-width); flex-shrink: 0; overflow-y: auto;
  border-left: 1px solid var(--border); background: var(--panel);
  padding: 1rem 1.1rem;
}
.panel-hint { color: var(--muted); font-size: 0.9rem; margin-top: 2rem; text-align: center; }
.panel-title { margin: 0.3rem 0 0.4rem; font-size: 1.3rem; }
.panel-analogy {
  font-size: 1rem; line-height: 1.45; font-style: italic; color: var(--text);
  background: var(--bg); border-left: 3px solid var(--accent);
  padding: 0.55rem 0.8rem; border-radius: 0 8px 8px 0; margin: 0 0 0.8rem;
}
.panel-definition { font-size: 0.95rem; line-height: 1.45; color: var(--text); margin: 0 0 0.8rem; }
.panel-section { margin: 1.1rem 0; padding-top: 1.1rem; border-top: 1px solid var(--border); }
.panel-section h3 { margin: 0 0 0.5rem; font-size: 0.9rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }

.step-player .step-controls { margin-bottom: 0.6rem; }
.steps-list-panel { list-style: decimal; margin: 0; padding-left: 1.3rem; font-size: 0.9rem; }
.steps-list-panel li { padding: 0.35rem 0.3rem; border-radius: 6px; margin-bottom: 0.2rem; line-height: 1.4; }
.steps-list-panel li strong { display: inline; }
.steps-list-panel li span { color: var(--muted); }
.steps-list-panel li.active { background: rgba(255, 193, 7, 0.22); font-weight: 600; }
.steps-list-panel li.done { opacity: 0.55; }
.steps-list-panel li.clickable { cursor: pointer; }
.steps-list-panel li.clickable:hover { background: rgba(127,127,127,0.12); }

.sim-frame {
  width: 100%; height: 480px; border: 1px solid var(--border); border-radius: 8px;
  background: white; margin-bottom: 0.6rem; display: block;
}
.sim-controls { display: flex; gap: 0.4rem; margin-bottom: 0.6rem; }

/* fullscreen simulation overlay - "make it so it shows a new panel with the
   full animation" per user feedback: the side panel can't always give a
   generated widget enough room, so let the user pop it out large */
#simOverlay {
  position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,0.75);
  display: none; align-items: center; justify-content: center; padding: 3vh 3vw;
}
#simOverlay.open { display: flex; }
.sim-overlay-box {
  width: 100%; height: 100%; max-width: 1100px; background: var(--panel);
  border-radius: 12px; display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 10px 40px rgba(0,0,0,0.5);
}
.sim-overlay-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.7rem 1rem; border-bottom: 1px solid var(--border);
}
.sim-overlay-header h3 { margin: 0; font-size: 1rem; }
.sim-overlay-box iframe { flex: 1; width: 100%; border: none; background: white; }

/* ---------- quiz ---------- */
#quizOverlay { position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,0.75); display: none; align-items: center; justify-content: center; padding: 3vh 3vw; }
#quizOverlay.open { display: flex; }
.quiz-box { max-width: 640px; height: auto; max-height: 85vh; }
#quizContent { padding: 1.2rem 1.4rem; overflow-y: auto; }
.quiz-progress { color: var(--muted); font-size: 0.8rem; margin-bottom: 0.5rem; }
.quiz-question { font-size: 1.1rem; font-weight: 600; margin-bottom: 1rem; }
.quiz-options { display: flex; flex-direction: column; gap: 0.5rem; }
.quiz-option {
  text-align: left; padding: 0.7rem 0.9rem; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text);
  cursor: pointer; font-size: 0.95rem;
}
.quiz-option:hover:not(:disabled) { filter: brightness(1.08); }
.quiz-option.correct { border-color: var(--accent); background: rgba(46,125,50,0.18); }
.quiz-option.wrong { border-color: var(--err); background: rgba(198,40,40,0.18); }
.quiz-explanation { margin-top: 0.9rem; padding: 0.7rem 0.9rem; background: var(--bg); border-radius: 8px; font-size: 0.9rem; }
.quiz-nav { margin-top: 1rem; display: flex; justify-content: flex-end; }
.quiz-score { font-size: 1.3rem; text-align: center; margin: 1rem 0; }
.check-question-wrap { margin-top: 0.8rem; padding-top: 0.8rem; border-top: 1px dashed var(--border); }
.check-question-wrap .quiz-question { font-size: 0.95rem; }

/* ---------- toasts: loud, hard-to-miss error/info feedback ---------- */
#toastContainer {
  position: fixed; top: 1rem; left: 50%; transform: translateX(-50%);
  z-index: 500; display: flex; flex-direction: column; gap: 0.5rem;
  pointer-events: none; align-items: center;
}
.toast {
  background: var(--err); color: white; padding: 0.7rem 1.1rem; border-radius: 8px;
  font-size: 0.9rem; box-shadow: 0 4px 14px rgba(0,0,0,0.3); max-width: 90vw;
  opacity: 0; transform: translateY(-12px); transition: opacity 0.25s ease, transform 0.25s ease;
}
.toast.show { opacity: 1; transform: translateY(0); }
.toast-ok { background: var(--accent); }

/* ---------- wrap-up: a nice standalone "webpage" summary ---------- */
#wrapupOverlay { position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,0.75); display: none; align-items: flex-start; justify-content: center; padding: 4vh 3vw; overflow-y: auto; }
#wrapupOverlay.open { display: flex; }
.wrapup-page {
  width: 100%; max-width: 720px; background: var(--panel); border-radius: 14px;
  padding: 2.2rem 2.4rem 2.6rem; box-shadow: 0 10px 40px rgba(0,0,0,0.5); position: relative;
}
.wrapup-close { position: absolute; top: 1.2rem; right: 1.2rem; }
.wrapup-title { font-size: 1.8rem; margin: 0 0 0.3rem; }
.wrapup-subtitle { color: var(--muted); font-size: 0.9rem; margin-bottom: 1.6rem; }
.wrapup-bullets { padding-left: 1.3rem; font-size: 1.05rem; line-height: 1.7; }
.wrapup-bullets li { margin-bottom: 0.7rem; }
.wrapup-hint { margin-top: 1.8rem; padding-top: 1.2rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85rem; text-align: center; }

@media (max-width: 900px) {
  :root { --panel-width: 100%; }
  #main { flex-direction: column; }
  #viewport { flex: 1 1 50%; }
  #panel { flex: 1 1 50%; border-left: none; border-top: 1px solid var(--border); }
}

/* ---------- animated stepper (replaces the plain highlighted-list "animation") ---------- */
.stepper { display: flex; align-items: flex-start; margin-bottom: 1rem; }
.stepper-node { display: flex; flex-direction: column; align-items: center; width: 40px; flex-shrink: 0; }
.stepper-circle {
  width: 34px; height: 34px; border-radius: 50%; border: 2px solid var(--border);
  display: flex; align-items: center; justify-content: center; font-weight: 700;
  font-size: 0.85rem; color: var(--muted); background: var(--panel);
  transition: all 0.4s cubic-bezier(.34,1.56,.64,1);
}
.stepper-circle.done { border-color: var(--accent); background: var(--accent); color: white; }
.stepper-circle.active {
  border-color: #ffc107; background: #ffc107; color: #1a1a1a;
  transform: scale(1.25); box-shadow: 0 0 0 6px rgba(255,193,7,0.25);
  animation: stepper-pulse 1.1s ease-in-out infinite;
}
@keyframes stepper-pulse {
  0%, 100% { box-shadow: 0 0 0 6px rgba(255,193,7,0.25); }
  50% { box-shadow: 0 0 0 11px rgba(255,193,7,0.12); }
}
.stepper-line {
  flex: 1; height: 3px; background: var(--border); margin-top: 16px;
  transition: background 0.4s ease; min-width: 20px;
}
.stepper-line.done { background: var(--accent); }
.step-detail-box {
  background: var(--bg); border-radius: 8px; padding: 0.7rem 0.9rem;
  min-height: 3.2rem; transition: opacity 0.25s ease;
}
.step-detail-box strong { display: block; margin-bottom: 0.2rem; }

````

---

## `frontend/app.js`

````javascript
/* Lecture -> living mind-map. See SUCCESS_CRITERIA.md for what each part
 * of this file needs to satisfy.
 *
 * Layout model: cards on the canvas are lightweight (label + tiny flip-back
 * definition). All the real interaction - full definition, step animation,
 * AI Q&A, image, interactive simulation - lives in the right panel for
 * whichever node is currently SELECTED. Selecting a node = clicking its
 * card (which also flips it, for a quick glance either way). */

// ---------- DOM refs ----------
const startBtn = document.getElementById("startBtn");
const wrapupBtn = document.getElementById("wrapupBtn");
const fitViewBtn = document.getElementById("fitViewBtn");
const quizBtn = document.getElementById("quizBtn");
const quizOverlay = document.getElementById("quizOverlay");
const quizContent = document.getElementById("quizContent");
const quizOverlayClose = document.getElementById("quizOverlayClose");
const wrapupOverlay = document.getElementById("wrapupOverlay");
const wrapupContent = document.getElementById("wrapupContent");
const wrapupClose = document.getElementById("wrapupClose");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const manualInput = document.getElementById("manualInput");
const viewport = document.getElementById("viewport");
const canvasEl = document.getElementById("canvas");
const edgeLayer = document.getElementById("edgeLayer");
const placeholderHint = document.getElementById("placeholderHint");
const panelEl = document.getElementById("panel");
const simOverlay = document.getElementById("simOverlay");
const simOverlayBox = document.querySelector(".sim-overlay-box");
const simOverlayTitle = document.getElementById("simOverlayTitle");
const simOverlayClose = document.getElementById("simOverlayClose");

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let fullTranscript = "";
let ws;
let listening = false;      // mic/speech-recognition state
let wsConnected = false;    // websocket state - INDEPENDENT of listening now,
// so ask/quiz/simulations/wrap-up etc. keep working after you hit Stop
let reconnectDelay = 1000;
let selectedNodeId = null;
let recognitionInstance = null;

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || "";
}

// ---------- global toast feedback ----------
// The small top status line is easy to miss (especially mid-lecture) and
// several actions used to fail completely silently if the websocket wasn't
// open - direct feedback: "no feedback like what it is" on both the quiz
// button and the ask box. Every user-triggered action now either succeeds
// visibly or shows a toast explaining why not.
const toastContainer = document.getElementById("toastContainer");
function showToast(message, kind = "err", duration = 6000) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function wsReady() {
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  showToast("Not connected right now - reconnecting automatically, try again in a moment.", "err");
  return false;
}

// ---------- category colors ----------
const CATEGORY_COLORS = {
  math: "#5b8def", code: "#8a5cf6", process: "#f5a623", theory: "#2fb380",
  warning: "#e5484d", definition: "#6b7280", interactive: "#00acc1",
};
function colorForCategory(cat) {
  if (CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
  let hash = 0;
  for (const ch of String(cat || "default")) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash}, 62%, 55%)`;
}

// ---------- node/graph state ----------
// nodeState[id] doubles as the d3 simulation's node object (x/y/vx/vy live
// directly on it) AND our app metadata (label/definition/qa/image/etc).
const nodeState = {};
window.nodeState = nodeState; // exposed for automated verification (see SUCCESS_CRITERIA.md)
const nodesArr = [];
let linksArr = [];
const cardEls = {};   // id -> card DOM element
const edgeEls = {};   // "from|to" -> {line, label}

const CARD_W = 190, CARD_H = 110;

// ---------- d3-force simulation ----------
function rectCollideForce() {
  let nodes;
  function force() {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const overlapX = CARD_W - Math.abs(dx);
        const overlapY = CARD_H - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX < overlapY) {
            const push = overlapX / 2 * (dx >= 0 ? 1 : -1) || 1;
            a.vx -= push; b.vx += push;
          } else {
            const push = overlapY / 2 * (dy >= 0 ? 1 : -1) || 1;
            a.vy -= push; b.vy += push;
          }
        }
      }
    }
  }
  force.initialize = (n) => { nodes = n; };
  return force;
}

// Tuned tighter than the initial defaults: the graph was spreading out
// with large dead gaps between clusters, forcing zoom-out far enough that
// labels became unreadable at scale (direct feedback). Less repulsion +
// shorter links + a stronger center pull keeps it compact without
// reintroducing card overlap (rectCollide still guarantees that separately).
const simulation = d3.forceSimulation([])
  .force("charge", d3.forceManyBody().strength(-260))
  .force("link", d3.forceLink([]).id((d) => d.id).distance(140))
  .force("center", d3.forceCenter(0, 0).strength(0.06))
  .force("rectCollide", rectCollideForce())
  .on("tick", onTick);

function onTick() {
  for (const id in cardEls) {
    const n = nodeState[id];
    cardEls[id].style.transform = `translate(${n.x}px, ${n.y}px)`;
  }
  drawEdges();
}

function drawEdges() {
  for (const key in edgeEls) {
    const { line, labelEl } = edgeEls[key];
    const [fromId, toId] = key.split("|");
    const a = nodeState[fromId], b = nodeState[toId];
    if (!a || !b) continue;
    line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
    labelEl.setAttribute("x", (a.x + b.x) / 2);
    labelEl.setAttribute("y", (a.y + b.y) / 2 - 4);
  }
}

// ---------- graph merge (never delete, reheat sim gently on new nodes) ----------
function mergeGraph(data) {
  const parentOf = {};
  for (const e of data.edges || []) parentOf[e.to] = e.from;

  let addedAny = false;
  for (const n of data.nodes || []) {
    if (nodeState[n.id]) {
      Object.assign(nodeState[n.id], {
        label: n.label, definition: n.definition, analogy: n.analogy, category: n.category,
        mode: n.mode, steps: n.steps || [],
      });
    } else {
      const parentId = parentOf[n.id];
      let x, y;
      if (parentId && nodeState[parentId]) {
        x = nodeState[parentId].x + (Math.random() - 0.5) * 40;
        y = nodeState[parentId].y + 160 + (Math.random() - 0.5) * 40;
      } else {
        x = (Math.random() - 0.5) * 120;
        y = (Math.random() - 0.5) * 120;
      }
      const node = Object.assign(
        {
          x, y, vx: 0, vy: 0, qa: [], image: null, widgetHtml: null,
          isNew: true, playing: false, currentStep: -1, pausedAtStep: null,
          lastError: null,
          // Persisted (not just local DOM state) so a pending request
          // survives navigating to another node and back - previously this
          // only lived on the button element itself, so clicking away made
          // an in-flight generation look "lost" and let a second click
          // double-fire a duplicate request for the same node.
          widgetPending: false, imagePending: false, askPending: false,
          videoPending: false, videoUrl: null,
          checkPending: false, checkQuestion: null, checkAnswered: false,
        },
        n, { steps: n.steps || [] }
      );
      nodeState[n.id] = node;
      nodesArr.push(node);
      addedAny = true;
    }
  }

  linksArr = (data.edges || [])
    .filter((e) => nodeState[e.from] && nodeState[e.to])
    .map((e) => ({ source: e.from, target: e.to, label: e.label }));

  simulation.nodes(nodesArr);
  simulation.force("link").links(linksArr);
  if (addedAny) simulation.alpha(0.6).restart();

  renderAllCards();
  renderEdgeElements();
  if (nodesArr.length) placeholderHint.style.display = "none";
}

function renderEdgeElements() {
  for (const e of linksArr) {
    const fromId = typeof e.source === "object" ? e.source.id : e.source;
    const toId = typeof e.target === "object" ? e.target.id : e.target;
    const key = `${fromId}|${toId}`;
    if (!edgeEls[key]) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      const labelEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      labelEl.setAttribute("text-anchor", "middle");
      labelEl.textContent = e.label || "";
      edgeLayer.appendChild(line);
      edgeLayer.appendChild(labelEl);
      edgeEls[key] = { line, labelEl };
    }
  }
}

// ---------- card rendering (lightweight: label + tiny flip-back definition) ----------
function renderAllCards() {
  for (const id in nodeState) {
    if (!cardEls[id]) createCard(nodeState[id]);
  }
}

function createCard(node) {
  const card = document.createElement("div");
  card.className = "card entering";
  card.dataset.nodeId = node.id;

  const inner = document.createElement("div");
  inner.className = "card-inner";

  const front = document.createElement("div");
  front.className = "card-face card-front";
  front.style.setProperty("--card-color", colorForCategory(node.category));
  const badge = document.createElement("div");
  badge.className = "card-badge";
  badge.textContent = node.category || "concept";
  const label = document.createElement("div");
  label.className = "card-label";
  label.textContent = node.label; // textContent only - never innerHTML with LLM text
  front.appendChild(badge);
  front.appendChild(label);
  if ((node.mode === "steps" || node.mode === "interactive") && node.steps && node.steps.length) {
    const hint = document.createElement("div");
    hint.className = "card-hint";
    hint.textContent = "⚡ has a simulation - click to explore";
    front.appendChild(hint);
  }

  const back = document.createElement("div");
  back.className = "card-face card-back";
  back.style.setProperty("--card-color", colorForCategory(node.category));
  const def = document.createElement("div");
  def.className = "card-definition";
  def.textContent = node.definition || node.label;
  back.appendChild(def);

  inner.appendChild(front);
  inner.appendChild(back);
  card.appendChild(inner);

  inner.addEventListener("click", () => {
    inner.classList.toggle("flipped");
    selectNode(node.id);
  });

  canvasEl.appendChild(card);
  cardEls[node.id] = card;
  requestAnimationFrame(() => card.classList.remove("entering"));
}

// ---------- right panel: the real interaction surface for one selected node ----------
function selectNode(nodeId) {
  selectedNodeId = nodeId;
  for (const id in cardEls) cardEls[id].classList.toggle("selected", id === nodeId);
  renderPanel();
}

function renderPanel() {
  panelEl.textContent = "";
  const node = nodeState[selectedNodeId];
  if (!node) {
    const hint = document.createElement("div");
    hint.className = "panel-hint";
    hint.textContent = "Click a concept on the map to explore it here.";
    panelEl.appendChild(hint);
    return;
  }

  const badge = document.createElement("div");
  badge.className = "card-badge";
  badge.style.setProperty("--card-color", colorForCategory(node.category));
  badge.textContent = node.category || "concept";
  panelEl.appendChild(badge);

  const title = document.createElement("h2");
  title.className = "panel-title";
  title.textContent = node.label;
  panelEl.appendChild(title);

  if (node.analogy) {
    const analogy = document.createElement("p");
    analogy.className = "panel-analogy";
    analogy.textContent = "💡 " + node.analogy;
    panelEl.appendChild(analogy);
  }

  const def = document.createElement("p");
  def.className = "panel-definition";
  def.textContent = node.definition || "";
  panelEl.appendChild(def);

  if (node.lastError) {
    const err = document.createElement("div");
    err.className = "card-error";
    err.textContent = "⚠ " + node.lastError;
    panelEl.appendChild(err);
  }

  if (node.steps && node.steps.length) renderStepPlayer(node);
  renderSimulationSection(node);
  renderVideoSection(node);
  renderImageSection(node);
  renderQaSection(node);
}

// ---------- teaching video (ElevenLabs - needs a Pro-tier key; wired and
// ready, but the actual generation call is confirmed blocked on a free-tier
// key: a live test returned 402 "requires a Pro plan or above". Shows a
// clear, specific message for that case rather than a generic error. ----------
function renderVideoSection(node) {
  const wrap = document.createElement("div");
  wrap.className = "panel-section";
  const heading = document.createElement("h3");
  heading.textContent = "Teaching video";
  wrap.appendChild(heading);

  if (node.videoUrl) {
    const video = document.createElement("video");
    video.src = node.videoUrl;
    video.controls = true;
    video.style.width = "100%";
    video.style.borderRadius = "8px";
    wrap.appendChild(video);

    const regenBtn = document.createElement("button");
    if (node.videoPending) {
      regenBtn.textContent = "Generating...";
      regenBtn.disabled = true;
    } else {
      regenBtn.textContent = "🔄 Regenerate";
      regenBtn.addEventListener("click", () => requestVideo(node, true));
    }
    wrap.appendChild(regenBtn);
  } else {
    const btn = document.createElement("button");
    if (node.videoPending) {
      btn.textContent = "Generating video (can take a few minutes)...";
      btn.disabled = true;
    } else {
      btn.textContent = "🎬 Generate teaching video";
      btn.addEventListener("click", () => requestVideo(node, false));
    }
    wrap.appendChild(btn);
  }
  panelEl.appendChild(wrap);
}

function requestVideo(node, force) {
  if (node.videoPending) return;
  if (!wsReady()) return;
  node.lastError = null;
  node.videoPending = true;
  ws.send(JSON.stringify({ type: "generate_video", node_id: node.id, force }));
  if (selectedNodeId === node.id) renderPanel();
}

// ---------- step player: a real animated stepper (circles + connecting
// line, active one pulses and scales up, completed ones fill solid) - not
// a plain highlighted list row, per direct feedback that the old version
// "isn't animation." Below it, the current step's detail shown large. ----------
function renderStepPlayer(node) {
  const wrap = document.createElement("div");
  wrap.className = "panel-section step-player";

  const heading = document.createElement("h3");
  heading.textContent = "Process walkthrough";
  wrap.appendChild(heading);

  const controls = document.createElement("div");
  controls.className = "step-controls";
  const playBtn = document.createElement("button");
  playBtn.textContent = node.playing ? "⏸ Pause" : (node.currentStep >= 0 ? "▶ Resume" : "▶ Animate");
  playBtn.addEventListener("click", () => {
    if (node.playing) pauseSteps(node.id); else playSteps(node.id);
  });
  controls.appendChild(playBtn);
  if (node.currentStep !== -1 || node.pausedAtStep != null) {
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "↻ Reset";
    resetBtn.addEventListener("click", () => resetSteps(node.id));
    controls.appendChild(resetBtn);
  }
  wrap.appendChild(controls);

  const stepper = document.createElement("div");
  stepper.className = "stepper";
  node.steps.forEach((step, i) => {
    const isDone = node.currentStep > i || (!node.playing && node.pausedAtStep != null && i < node.pausedAtStep);
    const isActive = i === node.currentStep;

    const nodeWrap = document.createElement("div");
    nodeWrap.className = "stepper-node";
    const circle = document.createElement("div");
    circle.className = "stepper-circle" + (isDone ? " done" : "") + (isActive ? " active" : "");
    circle.textContent = isDone ? "✓" : String(i + 1);
    nodeWrap.appendChild(circle);
    stepper.appendChild(nodeWrap);

    if (i < node.steps.length - 1) {
      const line = document.createElement("div");
      line.className = "stepper-line" + (isDone ? " done" : "");
      stepper.appendChild(line);
    }
  });
  wrap.appendChild(stepper);

  const detailBox = document.createElement("div");
  detailBox.className = "step-detail-box";
  const shownIndex = node.currentStep >= 0 ? node.currentStep : (node.pausedAtStep ?? 0);
  const shownStep = node.steps[shownIndex];
  if (shownStep) {
    const strong = document.createElement("strong");
    strong.textContent = `Step ${shownIndex + 1}: ${shownStep.label}`;
    const span = document.createElement("span");
    span.textContent = shownStep.detail || "";
    detailBox.appendChild(strong);
    detailBox.appendChild(span);
  } else {
    detailBox.textContent = "Click Animate to walk through each step.";
  }
  if (!node.playing) {
    detailBox.title = "Ask about this step";
    detailBox.style.cursor = "pointer";
    detailBox.addEventListener("click", () => {
      const input = panelEl.querySelector(".ask-form input");
      if (input && shownStep) { input.placeholder = `Ask about step "${shownStep.label}"...`; input.focus(); }
    });
  }
  wrap.appendChild(detailBox);

  panelEl.appendChild(wrap);
}

function playSteps(nodeId) {
  const node = nodeState[nodeId];
  if (!node || node.playing || !node.steps.length) return;
  node.playing = true;
  node.pausedAtStep = null;
  node.currentStep = -1;
  let i = 0;
  const advance = () => {
    if (!node.playing || i >= node.steps.length) {
      node.playing = false;
      if (selectedNodeId === nodeId) renderPanel();
      return;
    }
    node.currentStep = i;
    if (selectedNodeId === nodeId) renderPanel();
    i++;
    node.playTimeoutId = setTimeout(advance, 1400);
  };
  advance();
}

function pauseSteps(nodeId) {
  const node = nodeState[nodeId];
  if (!node) return;
  node.playing = false;
  clearTimeout(node.playTimeoutId);
  node.pausedAtStep = node.currentStep;
  if (selectedNodeId === nodeId) renderPanel();
}

function resetSteps(nodeId) {
  const node = nodeState[nodeId];
  if (!node) return;
  node.playing = false;
  clearTimeout(node.playTimeoutId);
  node.currentStep = -1;
  node.pausedAtStep = null;
  if (selectedNodeId === nodeId) renderPanel();
}

// ---------- interactive simulation (Gemini-generated, sandboxed iframe) ----------
function renderSimulationSection(node) {
  const wrap = document.createElement("div");
  wrap.className = "panel-section";
  const heading = document.createElement("h3");
  heading.textContent = "Interactive simulation";
  wrap.appendChild(heading);

  if (node.widgetHtml) {
    const controls = document.createElement("div");
    controls.className = "sim-controls";

    const expandBtn = document.createElement("button");
    expandBtn.textContent = "⛶ Open large";
    expandBtn.addEventListener("click", () => openSimFullscreen(node));
    controls.appendChild(expandBtn);

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "↻ Reset";
    resetBtn.title = "Reload the simulation to its starting state (no API call)";
    resetBtn.addEventListener("click", () => {
      const iframe = wrap.querySelector(".sim-frame");
      if (iframe) reloadIframe(iframe, node.widgetHtml);
    });
    controls.appendChild(resetBtn);

    const regenBtn = document.createElement("button");
    regenBtn.title = "Ask Gemini to write a fresh version of this simulation";
    if (node.widgetPending) {
      regenBtn.textContent = "Generating...";
      regenBtn.disabled = true;
    } else {
      regenBtn.textContent = "🔄 Regenerate";
      regenBtn.addEventListener("click", () => requestWidget(node, regenBtn, true));
    }
    controls.appendChild(regenBtn);

    wrap.appendChild(controls);

    const iframe = document.createElement("iframe");
    iframe.className = "sim-frame";
    // Security: allow-scripts WITHOUT allow-same-origin gives the widget an
    // opaque origin - can't read our cookies/localStorage/DOM, can't
    // navigate us, can't open popups/forms. srcdoc (not a data: URL) avoids
    // manual-escaping bugs. The generated HTML also carries a CSP
    // (connect-src 'none' etc, injected server-side) as defense-in-depth
    // against the one thing sandbox doesn't block: outbound network calls.
    iframe.sandbox = "allow-scripts";
    iframe.referrerPolicy = "no-referrer";
    wrap.appendChild(iframe);
    iframe.srcdoc = node.widgetHtml;

    // Active recall tied to the simulation they just played with - ties
    // two flagship features together instead of sitting next to each other.
    const checkWrap = document.createElement("div");
    checkWrap.className = "check-question-wrap";
    if (node.checkQuestion) {
      checkWrap.appendChild(buildQuestionElement(node.checkQuestion, () => {}));
    } else {
      const checkBtn = document.createElement("button");
      if (node.checkPending) {
        checkBtn.textContent = "Generating question...";
        checkBtn.disabled = true;
      } else {
        checkBtn.textContent = "🧠 Test yourself on this";
        checkBtn.addEventListener("click", () => {
          if (node.checkPending) return;
          if (!wsReady()) return;
          node.lastError = null;
          node.checkPending = true;
          ws.send(JSON.stringify({ type: "generate_check", node_id: node.id }));
          if (selectedNodeId === node.id) renderPanel();
        });
      }
      checkWrap.appendChild(checkBtn);
    }
    wrap.appendChild(checkWrap);
  } else {
    const btn = document.createElement("button");
    if (node.widgetPending) {
      btn.textContent = "Generating (can take ~15-25s)...";
      btn.disabled = true;
    } else {
      btn.textContent = "🧩 Generate interactive simulation";
      btn.addEventListener("click", () => requestWidget(node, btn));
    }
    wrap.appendChild(btn);
  }
  panelEl.appendChild(wrap);
}

function reloadIframe(iframe, html) {
  // Force a full reload of the same content to reset the widget's internal
  // JS state - reassigning srcdoc to the same string doesn't reliably
  // reload in every engine, so clear it first.
  iframe.srcdoc = "";
  requestAnimationFrame(() => { iframe.srcdoc = html; });
}

function openSimFullscreen(node) {
  simOverlayTitle.textContent = node.label;
  const existing = simOverlayBox.querySelector("iframe");
  if (existing) existing.remove();
  const existingControls = simOverlayBox.querySelector(".sim-controls");
  if (existingControls) existingControls.remove();

  const controls = document.createElement("div");
  controls.className = "sim-controls";
  controls.style.margin = "0.6rem 1rem 0";
  const resetBtn = document.createElement("button");
  resetBtn.textContent = "↻ Reset";
  controls.appendChild(resetBtn);
  simOverlayBox.querySelector(".sim-overlay-header").after(controls);

  const iframe = document.createElement("iframe");
  iframe.sandbox = "allow-scripts";
  iframe.referrerPolicy = "no-referrer";
  simOverlayBox.appendChild(iframe);
  iframe.srcdoc = node.widgetHtml;
  resetBtn.addEventListener("click", () => reloadIframe(iframe, node.widgetHtml));

  simOverlay.classList.add("open");
}

// Widgets self-report their real content height (see widgetgen.py's
// injected ResizeObserver script) so the iframe can fit its actual content
// instead of a fixed guessed height. The iframe's origin is opaque
// (sandbox="allow-scripts", no allow-same-origin), so event.origin is
// always the literal string "null" - validate via event.source instead.
window.addEventListener("message", (e) => {
  if (!e.data || !e.data.__widgetResize) return;
  const allFrames = [...document.querySelectorAll("#panel .sim-frame, #simOverlay iframe")];
  const frame = allFrames.find((f) => f.contentWindow === e.source);
  if (!frame) return;
  const height = Math.min(Math.max(e.data.height, 200), frame.closest("#simOverlay") ? 4000 : 900);
  frame.style.height = height + "px";
});

simOverlayClose.addEventListener("click", () => simOverlay.classList.remove("open"));
simOverlay.addEventListener("click", (e) => { if (e.target === simOverlay) simOverlay.classList.remove("open"); });

function requestWidget(node, btn, force = false) {
  if (node.widgetPending) return;
  if (!wsReady()) return;
  node.lastError = null;
  node.widgetPending = true;
  ws.send(JSON.stringify({ type: "generate_widget", node_id: node.id, force }));
  if (selectedNodeId === node.id) renderPanel(); // reflect the pending state immediately, not just the clicked button
}

// ---------- image ----------
function renderImageSection(node) {
  const wrap = document.createElement("div");
  wrap.className = "panel-section image-slot";
  if (node.image) {
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${node.image}`;
    img.alt = node.label;
    wrap.appendChild(img);
  } else {
    const btn = document.createElement("button");
    if (node.imagePending) {
      btn.textContent = "Generating…";
      btn.disabled = true;
    } else {
      btn.textContent = "🖼️ Generate image";
      btn.addEventListener("click", () => {
        if (node.imagePending) return;
        if (!wsReady()) return;
        node.lastError = null;
        node.imagePending = true;
        ws.send(JSON.stringify({ type: "generate_image", node_id: node.id }));
        if (selectedNodeId === node.id) renderPanel();
      });
    }
    wrap.appendChild(btn);
  }
  panelEl.appendChild(wrap);
}

// ---------- Q&A ----------
function renderQaSection(node) {
  const wrap = document.createElement("div");
  wrap.className = "panel-section";
  const heading = document.createElement("h3");
  heading.textContent = "Ask about this";
  wrap.appendChild(heading);

  if (node.qa.length) {
    const qaWrap = document.createElement("div");
    qaWrap.className = "qa-list";
    for (const pair of node.qa) {
      const item = document.createElement("div");
      item.className = "qa-item";
      const q = document.createElement("div");
      q.className = "qa-q";
      q.textContent = "Q: " + pair.question;
      const a = document.createElement("div");
      a.className = "qa-a";
      a.textContent = pair.answer;
      item.appendChild(q); item.appendChild(a);
      qaWrap.appendChild(item);
    }
    wrap.appendChild(qaWrap);
  }

  const form = document.createElement("div");
  form.className = "ask-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = node.askPending ? "Waiting for an answer..." : "Ask about this...";
  const askBtn = document.createElement("button");
  askBtn.textContent = node.askPending ? "…" : "Ask";
  if (node.askPending) { input.disabled = true; askBtn.disabled = true; }
  const submit = () => {
    const q = input.value.trim();
    if (!q || node.askPending) return;
    if (!wsReady()) return;
    node.lastError = null;
    node.askPending = true;
    ws.send(JSON.stringify({ type: "ask", node_id: node.id, question: q }));
    if (selectedNodeId === node.id) renderPanel();
  };
  askBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  form.appendChild(input); form.appendChild(askBtn);
  wrap.appendChild(form);
  panelEl.appendChild(wrap);
}

// ---------- WebSocket: connects once on page load, independent of the mic.
// Previously "Stop" closed the socket entirely, which silently broke every
// panel action (ask/quiz/simulations/wrap-up) with zero feedback - exactly
// the bug reported. Now Start/Stop only controls the microphone; the
// connection stays up (and auto-reconnects on any drop) so you can keep
// asking questions, generating simulations, and building the wrap-up
// summary whether or not you're actively "listening." ----------
connect();

startBtn.onclick = () => {
  if (listening) {
    listening = false;
    startBtn.textContent = "▶ Start listening";
    startBtn.classList.remove("active");
    if (recognitionInstance) { try { recognitionInstance.stop(); } catch (e) {} }
    setStatus(wsConnected ? "stopped listening (still connected)" : "stopped", "ok");
    return;
  }
  listening = true;
  startBtn.textContent = "■ Stop";
  startBtn.classList.add("active");
  if (SpeechRecognition) startRecognition();
  else showToast("Speech recognition not supported in this browser - use the text box below instead.", "err");
};

manualInput.addEventListener("input", () => {
  if (!wsReady()) return;
  const text = (fullTranscript + " " + manualInput.value).trim();
  ws.send(JSON.stringify({ text }));
});

function connect() {
  setStatus("connecting...");
  ws = new WebSocket(`ws://${location.host}/ws/lecture`);

  ws.onopen = () => {
    wsConnected = true;
    setStatus(listening ? "listening 🎙️" : "connected", "ok");
    reconnectDelay = 1000;
    const combined = (fullTranscript + " " + manualInput.value).trim();
    if (combined) ws.send(JSON.stringify({ text: combined }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "diagram") {
      mergeGraph(msg.data);
      if (listening) setStatus("listening 🎙️", "ok");
    } else if (msg.type === "empty") {
      if (listening) setStatus("listening 🎙️ (nothing new yet)", "ok");
    } else if (msg.type === "error") {
      setStatus(`backend error: ${msg.message}`, "err");
      const messages = {
        generate_image: "Image generation failed (model may be over quota) - try again later.",
        generate_widget: "Simulation generation failed - try again, or try a different concept.",
        generate_video: msg.needs_pro
          ? "Needs an ElevenLabs Pro plan - this key is free-tier only, so video generation is blocked (confirmed: 402 from their API)."
          : "Video generation failed - try again later.",
        ask: "That didn't go through - try asking again.",
        generate_check: "Couldn't generate a check question - try again.",
        generate_quiz: "Couldn't generate the quiz - try again.",
        generate_summary: "Couldn't generate the wrap-up summary - try again.",
      };
      const friendly = messages[msg.context] || `Gemini isn't accessible right now: ${msg.message}`;
      showToast(friendly, "err");

      // scoped failures (a specific card's ask/image/widget request) must
      // reset that node's panel UI, not just show a global status message -
      // otherwise the button is left stuck disabled forever with no recovery.
      if (msg.node_id && nodeState[msg.node_id]) {
        const node = nodeState[msg.node_id];
        node.lastError = friendly;
        // clear the matching pending flag - without this a failed request
        // left the node stuck "pending" forever (no error shown, no retry
        // possible) even though we now show an error banner.
        if (msg.context === "generate_widget") node.widgetPending = false;
        if (msg.context === "generate_image") node.imagePending = false;
        if (msg.context === "generate_video") node.videoPending = false;
        if (msg.context === "ask") node.askPending = false;
        if (msg.context === "generate_check") node.checkPending = false;
        if (selectedNodeId === msg.node_id) renderPanel();
      }

      // whole-lecture actions (quiz/wrap-up) have their own modal open with
      // a "Generating..." message that would otherwise sit frozen forever
      // with no visible explanation - update it directly, not just a toast.
      if (msg.context === "generate_quiz" && quizOverlay.classList.contains("open")) {
        quizContent.textContent = "";
        const err = document.createElement("div");
        err.className = "quiz-progress";
        err.textContent = "⚠ " + friendly;
        quizContent.appendChild(err);
        const retryBtn = document.createElement("button");
        retryBtn.textContent = "↻ Try again";
        retryBtn.addEventListener("click", () => quizBtn.click());
        quizContent.appendChild(retryBtn);
      }
      if (msg.context === "generate_summary" && wrapupOverlay.classList.contains("open")) {
        wrapupContent.textContent = "";
        const err = document.createElement("div");
        err.className = "quiz-progress";
        err.textContent = "⚠ " + friendly;
        wrapupContent.appendChild(err);
        const retryBtn = document.createElement("button");
        retryBtn.textContent = "↻ Try again";
        retryBtn.addEventListener("click", () => wrapupBtn.click());
        wrapupContent.appendChild(retryBtn);
      }
    } else if (msg.type === "answer") {
      const node = nodeState[msg.node_id];
      if (node) {
        node.qa.push({ question: msg.question, answer: msg.answer });
        node.askPending = false;
        if (selectedNodeId === msg.node_id) renderPanel();
      }
    } else if (msg.type === "image") {
      const node = nodeState[msg.node_id];
      if (node) {
        node.image = msg.image_base64;
        node.imagePending = false;
        if (msg.cached) setStatus("⚡ instant - seen this concept before", "ok");
        if (selectedNodeId === msg.node_id) renderPanel();
      }
    } else if (msg.type === "widget") {
      const node = nodeState[msg.node_id];
      if (node) {
        node.widgetHtml = msg.html;
        node.widgetPending = false;
        if (msg.cached) setStatus("⚡ instant - seen this concept before", "ok");
        if (selectedNodeId === msg.node_id) renderPanel();
      }
    } else if (msg.type === "video") {
      const node = nodeState[msg.node_id];
      if (node) {
        node.videoUrl = msg.video_url;
        node.videoPending = false;
        if (msg.cached) setStatus("⚡ instant - seen this concept before", "ok");
        if (selectedNodeId === msg.node_id) renderPanel();
      }
    } else if (msg.type === "quiz") {
      startQuiz(msg.questions);
    } else if (msg.type === "summary") {
      renderWrapup(msg.summary);
    } else if (msg.type === "check_question") {
      const node = nodeState[msg.node_id];
      if (node) {
        node.checkQuestion = msg.question;
        node.checkPending = false;
        if (selectedNodeId === msg.node_id) renderPanel();
      }
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    // always try to reconnect now, regardless of `listening` - the
    // connection is what powers ask/quiz/simulations/wrap-up too, not just
    // the mic pipeline, so it should never just stay dead.
    setStatus("reconnecting...", "err");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };

  ws.onerror = () => setStatus("connection error - retrying...", "err");
}

function startRecognition() {
  const recognition = new SpeechRecognition();
  recognitionInstance = recognition; // so Stop can actually call .stop() on it
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = "en-US";

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        fullTranscript += " " + event.results[i][0].transcript;
        transcriptEl.textContent = fullTranscript;
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ text: (fullTranscript + " " + manualInput.value).trim() }));
        }
      }
    }
  };

  recognition.onerror = (event) => {
    console.error("SpeechRecognition error:", event.error);
    if (event.error === "no-speech") return;
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      showToast("Mic permission denied - allow microphone access, or use the text box below instead.", "err");
      return;
    }
    if (event.error === "network") {
      showToast("Speech recognition needs network access and failed - use the text box below instead.", "err");
      return;
    }
    showToast(`Mic error: ${event.error} - use the text box below if this persists.`, "err");
  };

  recognition.onend = () => { if (listening) { try { recognition.start(); } catch (e) {} } };
  try { recognition.start(); } catch (e) { setStatus("Could not start microphone - use the text box below instead.", "err"); }
}

// ---------- pan / zoom (pointer events: mouse + touch + pinch) ----------
let panX = 0, panY = 0, zoom = 1;
let isDragging = false, dragStart = { x: 0, y: 0 }, panStart = { x: 0, y: 0 };
const activePointers = new Map();
let lastPinchDist = null;

function applyTransform() {
  canvasEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

viewport.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".card")) return;
  viewport.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 1) {
    isDragging = true;
    viewport.classList.add("dragging");
    dragStart = { x: e.clientX, y: e.clientY };
    panStart = { x: panX, y: panY };
  }
});

viewport.addEventListener("pointermove", (e) => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 2) {
    const pts = [...activePointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (lastPinchDist != null) {
      zoom = Math.min(2.5, Math.max(0.2, zoom * (dist / lastPinchDist)));
      applyTransform();
    }
    lastPinchDist = dist;
  } else if (activePointers.size === 1 && isDragging) {
    panX = panStart.x + (e.clientX - dragStart.x);
    panY = panStart.y + (e.clientY - dragStart.y);
    applyTransform();
  }
});

function endPointer(e) {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) lastPinchDist = null;
  if (activePointers.size === 0) { isDragging = false; viewport.classList.remove("dragging"); }
}
viewport.addEventListener("pointerup", endPointer);
viewport.addEventListener("pointercancel", endPointer);

viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoom = Math.min(2.5, Math.max(0.2, zoom - e.deltaY * 0.001));
  applyTransform();
}, { passive: false });

// ---------- fit-to-view: computes the bounding box of every node and sets
// pan/zoom so the whole graph is framed, instead of manually guessing ----------
function fitToView() {
  const ids = Object.keys(nodeState);
  if (!ids.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) {
    const n = nodeState[id];
    minX = Math.min(minX, n.x - CARD_W / 2); maxX = Math.max(maxX, n.x + CARD_W / 2);
    minY = Math.min(minY, n.y - CARD_H / 2); maxY = Math.max(maxY, n.y + CARD_H / 2);
  }
  const graphW = maxX - minX, graphH = maxY - minY;
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  const padding = 60;
  zoom = Math.min(2.5, Math.max(0.15, Math.min((vw - padding * 2) / graphW, (vh - padding * 2) / graphH)));
  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
  panX = -centerX * zoom;
  panY = -centerY * zoom;
  applyTransform();
}
fitViewBtn.addEventListener("click", fitToView);

// ---------- quiz: one batch call over the whole map, cheap regardless of
// how many concepts exist. Not cached - the map keeps growing, so a quiz
// should reflect what's on it right now, not a stale earlier snapshot. ----------
let quizState = null; // {questions, index, score, answered}

quizBtn.addEventListener("click", () => {
  quizOverlay.classList.add("open"); // open first so wsReady()'s toast is visible against it
  if (!wsReady()) return;
  quizContent.textContent = "";
  const loading = document.createElement("div");
  loading.className = "quiz-progress";
  loading.textContent = "Generating quiz from everything covered so far...";
  quizContent.appendChild(loading);
  ws.send(JSON.stringify({ type: "generate_quiz" }));
});

quizOverlayClose.addEventListener("click", () => quizOverlay.classList.remove("open"));
quizOverlay.addEventListener("click", (e) => { if (e.target === quizOverlay) quizOverlay.classList.remove("open"); });

// ---------- wrap-up: a nice "webpage" summary. Purely a view - closing it
// (or never opening it) leaves the live mind-map and every other feature
// exactly as functional as before, since generating it never touches the
// graph. "Wrap up" replaces the old "Generate diagram now" button, which
// was redundant with the automatic ~20s timer. ----------
wrapupBtn.addEventListener("click", () => {
  wrapupOverlay.classList.add("open");
  if (!wsReady()) return;
  wrapupContent.textContent = "";
  const loading = document.createElement("div");
  loading.className = "quiz-progress";
  loading.textContent = "Summarizing everything covered so far...";
  wrapupContent.appendChild(loading);
  ws.send(JSON.stringify({ type: "generate_summary" }));
});

wrapupClose.addEventListener("click", () => wrapupOverlay.classList.remove("open"));

function renderWrapup(summary) {
  wrapupContent.textContent = "";
  if (!summary || !summary.bullets || !summary.bullets.length) {
    const msg = document.createElement("div");
    msg.className = "quiz-progress";
    msg.textContent = "Not enough on the map yet to summarize - keep listening a bit longer.";
    wrapupContent.appendChild(msg);
    return;
  }

  const title = document.createElement("h1");
  title.className = "wrapup-title";
  title.textContent = summary.title;
  wrapupContent.appendChild(title);

  const subtitle = document.createElement("div");
  subtitle.className = "wrapup-subtitle";
  subtitle.textContent = `${Object.keys(nodeState).length} concepts covered`;
  wrapupContent.appendChild(subtitle);

  const list = document.createElement("ul");
  list.className = "wrapup-bullets";
  for (const bullet of summary.bullets) {
    const li = document.createElement("li");
    li.textContent = bullet;
    list.appendChild(li);
  }
  wrapupContent.appendChild(list);

  const hint = document.createElement("div");
  hint.className = "wrapup-hint";
  hint.textContent = "Close this and keep going - the map, simulations, and everything else are still right here.";
  wrapupContent.appendChild(hint);
}

function startQuiz(questions) {
  if (!questions || !questions.length) {
    quizContent.textContent = "";
    const msg = document.createElement("div");
    msg.className = "quiz-progress";
    msg.textContent = "Not enough on the map yet to build a quiz - keep listening a bit longer.";
    quizContent.appendChild(msg);
    return;
  }
  quizState = { questions, index: 0, score: 0, answered: false };
  renderQuizQuestion();
}

// Shared by the whole-lecture quiz AND the per-simulation check question
// (active recall, click an option -> immediate correct/wrong + explanation).
// `onAnswered(wasCorrect)` fires once, after the explanation is shown.
function buildQuestionElement(q, onAnswered) {
  const wrap = document.createElement("div");
  wrap.className = "quiz-question-block";

  const question = document.createElement("div");
  question.className = "quiz-question";
  question.textContent = q.question;
  wrap.appendChild(question);

  const optionsWrap = document.createElement("div");
  optionsWrap.className = "quiz-options";
  let answered = false;
  q.options.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.className = "quiz-option";
    btn.textContent = opt;
    btn.addEventListener("click", () => {
      if (answered) return;
      answered = true;
      const correct = i === q.correct_index;
      [...optionsWrap.children].forEach((b, j) => {
        b.disabled = true;
        if (j === q.correct_index) b.classList.add("correct");
        else if (j === i) b.classList.add("wrong");
      });
      const explanation = document.createElement("div");
      explanation.className = "quiz-explanation";
      explanation.textContent = (correct ? "✅ Correct. " : "❌ Not quite. ") + (q.explanation || "");
      wrap.appendChild(explanation);
      if (onAnswered) onAnswered(correct);
    });
    optionsWrap.appendChild(btn);
  });
  wrap.appendChild(optionsWrap);
  return wrap;
}

function renderQuizQuestion() {
  quizContent.textContent = "";
  const { questions, index } = quizState;
  const q = questions[index];

  const progress = document.createElement("div");
  progress.className = "quiz-progress";
  progress.textContent = `Question ${index + 1} of ${questions.length}`;
  quizContent.appendChild(progress);

  quizContent.appendChild(buildQuestionElement(q, (correct) => {
    if (correct) quizState.score++;
    const nav = document.createElement("div");
    nav.className = "quiz-nav";
    const nextBtn = document.createElement("button");
    nextBtn.textContent = quizState.index < quizState.questions.length - 1 ? "Next question →" : "See results";
    nextBtn.addEventListener("click", () => {
      quizState.index++;
      if (quizState.index < quizState.questions.length) renderQuizQuestion();
      else renderQuizResults();
    });
    nav.appendChild(nextBtn);
    quizContent.appendChild(nav);
  }));
}

function renderQuizResults() {
  quizContent.textContent = "";
  const score = document.createElement("div");
  score.className = "quiz-score";
  score.textContent = `${quizState.score} / ${quizState.questions.length} correct`;
  quizContent.appendChild(score);

  const retakeBtn = document.createElement("button");
  retakeBtn.textContent = "↻ Retake";
  retakeBtn.addEventListener("click", () => { quizState.index = 0; quizState.score = 0; quizState.answered = false; renderQuizQuestion(); });
  quizContent.appendChild(retakeBtn);
}

````

---

