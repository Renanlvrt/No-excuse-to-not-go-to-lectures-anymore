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
