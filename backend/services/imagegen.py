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
