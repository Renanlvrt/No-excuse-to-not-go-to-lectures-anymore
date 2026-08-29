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
