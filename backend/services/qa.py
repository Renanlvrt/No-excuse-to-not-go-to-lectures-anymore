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
