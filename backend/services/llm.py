"""Shared Gemini call helper.

Different Gemini model names draw from SEPARATE free-tier quota pools (learned
the hard way mid-demo: gemini-3.6-flash ran out, lite/latest variants didn't).
Every text-generating feature (diagram extraction, Q&A) goes through this so
they all get the same automatic fallback instead of each reimplementing it.
"""
import os
import google.generativeai as genai

genai.configure(api_key=os.getenv("GEMINI_API_KEY"), transport="rest")

# Order matters for live latency, not just for quota. Measured on the demo
# machine with a real extraction prompt: 3.1-flash-lite answers in ~2s, the
# -latest aliases take 10-18s, and gemini-flash-latest is already 429ing.
# Extraction blocks the event loop, so the fastest healthy model goes first.
MODEL_FALLBACK_CHAIN = [
    "gemini-3.1-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.6-flash",
    "gemini-flash-latest",
]

_model_cache = {}
_working_model_index = 0  # sticky: once one works, start there next time


def _get_model(name: str, system_instruction: str):
    key = (name, system_instruction)
    if key not in _model_cache:
        _model_cache[key] = genai.GenerativeModel(name, system_instruction=system_instruction)
    return _model_cache[key]


def generate_with_fallback(
    prompt: str,
    system_instruction: str,
    timeout: int = 15,
    json_mode: bool = False,
    max_attempts: int | None = None,
) -> str:
    """max_attempts bounds the worst case for callers that block the event loop:
    the whole chain can otherwise cost len(chain) * timeout seconds."""
    global _working_model_index
    last_error = None
    gen_config = genai.GenerationConfig(response_mime_type="application/json") if json_mode else None
    order = list(range(_working_model_index, len(MODEL_FALLBACK_CHAIN))) + list(range(_working_model_index))
    if max_attempts is not None:
        order = order[:max_attempts]
    for i in order:
        name = MODEL_FALLBACK_CHAIN[i]
        try:
            model = _get_model(name, system_instruction)
            response = model.generate_content(
                prompt, request_options={"timeout": timeout}, generation_config=gen_config
            )
        except Exception as e:
            last_error = e
            # Move the sticky pointer off a model that just failed. Otherwise a
            # model that runs out of daily quota stays first in line and, with
            # max_attempts=2, burns half of every later call on a known-dead
            # model - the app then only recovers on a server restart.
            if _working_model_index == i:
                _working_model_index = (i + 1) % len(MODEL_FALLBACK_CHAIN)
            continue
        _working_model_index = i
        return response.text or ""
    raise last_error
