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
