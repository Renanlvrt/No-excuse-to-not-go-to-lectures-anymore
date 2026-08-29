"""ElevenLabs Scribe speech-to-text.

Two entry points:
- `transcribe_chunk`: one-shot batch transcription of a complete audio file.
- `RealtimeTranscriber`: a live websocket session (Scribe v2 realtime) that
  streams PCM16 chunks up and yields `partial_transcript` (interim, may
  change) and `committed_transcript` (stable) text back through callbacks.

The realtime session is held server-side so the API key never reaches the
browser: the frontend ships raw mic audio over the app's own websocket and
this module relays it to ElevenLabs.
"""
import asyncio
import json
import os
from typing import Awaitable, Callable
from urllib.parse import urlencode

import websockets
from elevenlabs.client import ElevenLabs

REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
REALTIME_MODEL = "scribe_v2_realtime"
SAMPLE_RATE = 16000


def transcribe_chunk(audio_bytes: bytes) -> str:
    """Send one audio chunk to ElevenLabs Scribe, return text."""
    client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))
    result = client.speech_to_text.convert(
        file=audio_bytes,
        model_id="scribe_v1",
    )
    return result.text or ""


class RealtimeTranscriber:
    """One live ElevenLabs Scribe session.

    VAD commit strategy: ElevenLabs itself decides where a speech segment
    ends, so the caller just keeps pushing audio and gets committed
    sentences back - no client-side silence detection needed.
    """

    def __init__(
        self,
        api_key: str,
        on_partial: Callable[[str], Awaitable[None]],
        on_committed: Callable[[str], Awaitable[None]],
        on_error: Callable[[str], Awaitable[None]],
    ):
        self._api_key = api_key
        self._on_partial = on_partial
        self._on_committed = on_committed
        self._on_error = on_error
        self._ws: websockets.ClientConnection | None = None
        self._reader: asyncio.Task | None = None

    async def start(self) -> None:
        query = urlencode({
            "model_id": REALTIME_MODEL,
            "audio_format": f"pcm_{SAMPLE_RATE}",
            "commit_strategy": "vad",
        })
        self._ws = await websockets.connect(
            f"{REALTIME_URL}?{query}",
            additional_headers={"xi-api-key": self._api_key},
            max_size=None,
        )
        self._reader = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                kind = msg.get("message_type")
                if kind == "partial_transcript":
                    await self._on_partial(msg.get("text", ""))
                elif kind == "committed_transcript":
                    text = (msg.get("text") or "").strip()
                    if text:
                        await self._on_committed(text)
                elif kind in ("input_error", "error", "unaccepted_terms"):
                    await self._on_error(str(msg.get("error") or msg)[:200])
        except asyncio.CancelledError:
            raise
        except websockets.ConnectionClosed:
            pass
        except Exception as e:  # keep a transcription hiccup from killing the app socket
            await self._on_error(str(e)[:200])

    async def send_audio(self, audio_base_64: str) -> None:
        if not self._ws:
            return
        await self._ws.send(json.dumps({
            "message_type": "input_audio_chunk",
            "audio_base_64": audio_base_64,
            "commit": False,
            "sample_rate": SAMPLE_RATE,
        }))

    async def commit(self) -> None:
        """Force-close the current segment (used when the user hits Stop, so
        the tail of a sentence isn't left uncommitted inside ElevenLabs)."""
        if not self._ws:
            return
        await self._ws.send(json.dumps({
            "message_type": "input_audio_chunk",
            "audio_base_64": "",
            "commit": True,
            "sample_rate": SAMPLE_RATE,
        }))

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
            self._reader = None
        if self._ws:
            try:
                await self._ws.close()
            finally:
                self._ws = None
