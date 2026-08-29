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
