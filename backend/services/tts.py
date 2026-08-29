"""ElevenLabs text-to-speech, one voice per comprehension level.

The sound tells you which level you're on before you read a word: L1 is a
warm storyteller taking his time, L2 a clear neutral educator, L3 a fast,
dense broadcaster. All three are `premade` voices - library voices are
402-blocked on the free tier (verified), these are not.

Async httpx + truststore for the same reason videogen.py uses them: every
blocking call here freezes the single event loop, and threads deadlock on
this machine.

Cached to disk by (concept slug, level, hash of the spoken text) and served
from the /audio mount, so a replay of identical text costs zero characters of
the free-tier TTS quota and never ships a payload over the websocket. The
text hash is what makes the cache honest: the same concept at the same level
can be asked to speak different text (a definition before the deep
explanation exists, the deep explanation after), and those must never land on
the same file.
"""
import hashlib
import re
from pathlib import Path

import httpx
import truststore

from backend.services.cache import slug

truststore.inject_into_ssl()

AUDIO_DIR = Path(__file__).parent.parent.parent / "data" / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)

BASE_URL = "https://api.elevenlabs.io/v1/text-to-speech"
MODEL_ID = "eleven_turbo_v2_5"
MAX_CHARS = 900  # free-tier quota guard: one panel of text, never a whole lecture

LEVEL_VOICES = {
    1: {"voice_id": "JBFqnCBsd6RMkjVDRZzb", "speed": 0.8, "stability": 0.5},   # George, warm
    2: {"voice_id": "Xb7hH8MSUJpSbSDYk0k2", "speed": 1.0, "stability": 0.5},   # Alice, neutral
    3: {"voice_id": "onwK4e9ZLuTAKqWW03F9", "speed": 1.15, "stability": 0.35},  # Daniel, dense
}


def _text_hash(text: str) -> str:
    normalised = re.sub(r"\s+", " ", text).strip().lower()
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()[:12]


def _cached_path(label: str, level: int, text: str) -> Path:
    """Key includes a hash of the exact text sent to the API, so two different
    texts for one (concept, level) can never collide onto one mp3."""
    return AUDIO_DIR / f"{slug(label)}_l{level}_{_text_hash(text)}.mp3"


async def speak_level(label: str, level: int, text: str, api_key: str, force: bool = False) -> tuple[str, bool]:
    """Returns (filename_relative_to_AUDIO_DIR, was_cached)."""
    spoken = text[:MAX_CHARS]
    cached = _cached_path(label, level, spoken)
    if not force and cached.exists():
        return cached.name, True

    voice = LEVEL_VOICES.get(level, LEVEL_VOICES[2])
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{BASE_URL}/{voice['voice_id']}",
            headers={"xi-api-key": api_key, "Content-Type": "application/json"},
            json={
                "text": spoken,
                "model_id": MODEL_ID,
                "voice_settings": {
                    "stability": voice["stability"],
                    "similarity_boost": 0.75,
                    "speed": voice["speed"],
                },
            },
        )
        resp.raise_for_status()

    cached.write_bytes(resp.content)
    return cached.name, False
