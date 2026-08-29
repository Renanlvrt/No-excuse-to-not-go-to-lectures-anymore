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
import time
from typing import Awaitable, Callable
from urllib.parse import urlencode

import websockets
from elevenlabs.client import ElevenLabs

REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
REALTIME_MODEL = "scribe_v2_realtime"
SAMPLE_RATE = 16000
VAD_SILENCE_SECS = 0.4   # close a segment after this much silence
MIN_SILENCE_MS = 200     # what counts as silence at all
MIN_SPEECH_MS = 150      # ignore shorter blips (keyboard, chair) as speech
MAX_SEGMENT_SECS = 6.0   # hard ceiling on how long text may stay uncommitted


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

    Commit strategy: VAD (ElevenLabs decides where a speech segment ends)
    plus our own ceiling. VAD alone is not enough for a lecture - measured on
    21s of uninterrupted speech it committed nothing at all, so the transcript
    only landed once the audio stopped. So the segment is also force-closed
    every MAX_SEGMENT_SECS of continuous audio.
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
        self._segment_started: float | None = None

    async def start(self) -> None:
        query = urlencode({
            "model_id": REALTIME_MODEL,
            "audio_format": f"pcm_{SAMPLE_RATE}",
            "commit_strategy": "vad",
            # A lecturer barely pauses, so with the default silence window a
            # segment only got committed once the audio stopped - the whole
            # transcript landed seconds after you paused the video. These cut
            # a segment at the natural micro-pause between sentences instead.
            "vad_silence_threshold_secs": VAD_SILENCE_SECS,
            "min_silence_duration_ms": MIN_SILENCE_MS,
            "min_speech_duration_ms": MIN_SPEECH_MS,
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
                print(f"[TRACE] scribe event: {kind}", flush=True)
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
        now = time.monotonic()
        if self._segment_started is None:
            self._segment_started = now
        due = now - self._segment_started >= MAX_SEGMENT_SECS
        if due:
            self._segment_started = now
        await self._ws.send(json.dumps({
            "message_type": "input_audio_chunk",
            "audio_base_64": audio_base_64,
            "commit": due,
            "sample_rate": SAMPLE_RATE,
        }))

    async def commit(self) -> None:
        """Force-close the current segment (used when the user hits Stop, so
        the tail of a sentence isn't left uncommitted inside ElevenLabs)."""
        if not self._ws:
            return
        self._segment_started = None
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
