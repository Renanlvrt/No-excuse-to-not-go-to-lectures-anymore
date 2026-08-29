"""LLM: the "Rigour" reading of one concept - the exam-level answer.

Level 3 of the three comprehension levels. L1 (intuition) and L2 (mechanism)
are the node's existing analogy/definition fields and cost nothing; only this
one is generated, on demand, once per concept ever (cached by concept slug
like widgets and images).
"""
from backend.services.llm import generate_with_fallback
from backend.services.cache import get_cached, set_cached

CACHE_NAME = "deep"

SYSTEM = """You are an exacting professor giving the rigorous version of one
concept from a student's lecture notes - the answer that would survive being
grilled in an oral exam. Be precise: state it formally, use standard notation
where it helps, and name at least one edge case, failure mode, or common
misconception students get wrong. 3-5 sentences, plain text, no markdown, no
headers, no bullet points - this renders in a small panel on their screen."""


def explain_deep(label: str, definition: str, force: bool = False) -> tuple[str, bool]:
    """Returns (text, was_cached)."""
    if not force:
        cached = get_cached(CACHE_NAME, label)
        if cached:
            return cached, True

    prompt = f"Concept: {label}\nDefinition on their card: {definition}\n\nGive the rigorous version now."
    text = generate_with_fallback(prompt, SYSTEM, timeout=15).strip()
    set_cached(CACHE_NAME, label, text)
    return text, False
