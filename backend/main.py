"""FastAPI app: live transcript text in -> live growing concept-graph out."""
import asyncio
import os
import pip_system_certs.wrapt_requests  # trust Windows cert store (fixes Avast SSL-scan MITM)
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

load_dotenv()

from backend.services.diagram import extract_flowchart
from backend.services.qa import answer_question
from backend.services.imagegen import generate_image
from backend.services.widgetgen import generate_widget
from backend.services.videogen import generate_video, NeedsProPlanError, VIDEO_DIR
from backend.services.quizgen import generate_quiz, generate_check_question
from backend.services.summarygen import generate_summary
from backend.services.explain import explain_deep
from backend.services.intent import match_level_intent
from backend.services.tts import speak_level, AUDIO_DIR
from backend.services.transcribe import RealtimeTranscriber

ELEVENLABS_API_KEY = (os.getenv("ELEVENLABS_API_KEY") or "").strip()

app = FastAPI()

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
app.mount("/static", StaticFiles(directory=FRONTEND_DIR, html=True), name="static")
app.mount("/videos", StaticFiles(directory=VIDEO_DIR), name="videos")
app.mount("/audio", StaticFiles(directory=AUDIO_DIR), name="audio")

EXTRACTION_INTERVAL_SECONDS = 20  # ~3 calls/min: stays well under Gemini free-tier's
# ~10 RPM cap, and under a ~2hr live lecture keeps total calls within the free
# tier's daily request budget (reportedly as low as ~250/day for flash models
# on the free tier as of late-2025 quota cuts).
MAX_BACKOFF_SKIPS = 6  # after an error (e.g. rate-limited), wait up to 6 extra
# cycles (~2 more minutes) before trying again, instead of hammering an API
# that's already saying no.


def _find_node(graph: dict, node_id: str) -> dict | None:
    for n in graph.get("nodes", []):
        if n.get("id") == node_id:
            return n
    return None


@app.websocket("/ws/lecture")
async def lecture_ws(ws: WebSocket):
    await ws.accept()
    state = {
        "transcript": "",  # speech, owned by the server when ElevenLabs is transcribing
        "manual": "",      # whatever is typed/pasted in the frontend's text box
        "last_extracted": "",
        "graph": {"nodes": [], "edges": []},
        # Everything here runs as blocking synchronous Gemini calls on one
        # shared event loop (threads deadlock on this machine - see
        # llm.py/README). A user's button click and the periodic extraction
        # timer therefore genuinely contend for the same execution slot; if
        # the extraction cycle is running (or a prior action still is) when
        # you click, the click just waits. This flag doesn't let the
        # extraction timer skip a cycle it's already mid-call for  - nothing
        # can preempt a call already running - but it stops a NEW extraction
        # cycle from starting while a user action is in flight, so a click
        # made during "listening" doesn't get queued behind a fresh 20s
        # extraction that was about to start anyway.
        "busy": False,
        # live ElevenLabs Scribe session, created lazily on the first audio
        # chunk so a listener who never turns the mic on costs nothing.
        "stt": None,
        # this machine's .env key, or one the listener pasted into the UI on a
        # laptop that has no .env at all.
        "api_key": ELEVENLABS_API_KEY,
        # the card the student is looking at - the target of spoken level
        # commands ("explain that simpler").
        "selected_node_id": None,
    }
    force_event = asyncio.Event()

    async def send_stt_status():
        await ws.send_json({
            "type": "stt_status",
            "provider": "elevenlabs",
            "has_key": bool(state["api_key"]),
            "from_server": bool(ELEVENLABS_API_KEY),
        })

    await send_stt_status()

    async def on_partial(text: str):
        await ws.send_json({"type": "partial_transcript", "text": text})

    async def on_committed(text: str):
        # the segment always goes into the transcript first, command or not:
        # a trigger phrase must never silently disappear from what feeds
        # concept extraction.
        state["transcript"] = (state["transcript"] + " " + text).strip()
        await ws.send_json({"type": "transcript", "text": state["transcript"], "committed": text})

        level = match_level_intent(text)
        if level and state["selected_node_id"]:
            await ws.send_json({
                "type": "level_intent", "node_id": state["selected_node_id"],
                "level": level, "phrase": text.strip(),
            })

    async def on_stt_error(message: str):
        await ws.send_json({"type": "error", "context": "transcribe", "message": message})

    async def stop_transcriber(commit: bool):
        transcriber = state["stt"]
        state["stt"] = None
        if not transcriber:
            return
        try:
            if commit:
                await transcriber.commit()
                # give ElevenLabs a beat to emit the final committed segment
                # before tearing the socket down, otherwise the last sentence
                # spoken before "Stop" is silently lost.
                await asyncio.sleep(1.0)
        except Exception:
            pass
        await transcriber.close()

    def store_deep(node: dict, result: tuple[str, bool]) -> dict:
        """Kept on the node itself so extract_flowchart's merge (which re-emits
        an existing node verbatim) carries the level-3 text forward instead of
        dropping it on the next extraction cycle."""
        text, cached = result
        node["deep"] = text
        return {"type": "deep", "node_id": node["id"], "text": text, "cached": cached}

    async def handle_node_action(msg: dict, context: str, run, ok_payload):
        """Shared per-node action pattern (ask / generate_image /
        generate_widget): look up the node, run the (blocking) call, reply
        with either a success payload or a node-scoped error the frontend
        can use to reset that specific card's UI instead of hanging."""
        node = _find_node(state["graph"], msg.get("node_id"))
        if not node:
            # include node_id even on this path (not just node["id"], since we
            # have no node) so the frontend can still reset that card's UI -
            # otherwise a request for a node the server doesn't recognize
            # (e.g. after a reconnect) leaves the button stuck "pending" forever.
            await ws.send_json({
                "type": "error", "node_id": msg.get("node_id"), "context": context,
                "message": f"unknown node for {context}",
            })
            return
        state["busy"] = True
        try:
            result = run(node)
            await ws.send_json(ok_payload(node, result))
        except Exception as e:
            await ws.send_json({
                "type": "error", "node_id": node["id"], "context": context,
                "message": f"{context} failed: {str(e)[:200]}",
            })
        finally:
            state["busy"] = False

    async def handle_generate_video(msg: dict):
        """Unlike ask/image/widget, this genuinely runs concurrently rather
        than blocking receive_loop/extraction_loop - video generation is a
        multi-minute poll, and holding the whole app hostage for that long
        would be far worse than the brief blocking calls elsewhere. Spawned
        via asyncio.create_task below (fire-and-forget from the caller's
        side), so a user can navigate away, keep talking, or trigger other
        actions while a video renders in the background."""
        node = _find_node(state["graph"], msg.get("node_id"))
        if not node:
            await ws.send_json({
                "type": "error", "node_id": msg.get("node_id"), "context": "generate_video",
                "message": "unknown node for generate_video",
            })
            return
        if not state["api_key"]:
            await ws.send_json({
                "type": "error", "node_id": node["id"], "context": "generate_video",
                "message": "No ElevenLabs API key configured.",
            })
            return
        try:
            filename, cached = await generate_video(
                node["label"], node.get("definition", ""), state["api_key"], force=msg.get("force", False)
            )
            await ws.send_json({
                "type": "video", "node_id": node["id"], "video_url": f"/videos/{filename}", "cached": cached,
            })
        except NeedsProPlanError as e:
            await ws.send_json({
                "type": "error", "node_id": node["id"], "context": "generate_video",
                "message": str(e), "needs_pro": True,
            })
        except Exception as e:
            await ws.send_json({
                "type": "error", "node_id": node["id"], "context": "generate_video",
                "message": f"video generation failed: {str(e)[:200]}",
            })

    async def handle_speak_level(msg: dict):
        """Like video, this runs as its own task on real async I/O rather than
        blocking the loop - the lecture keeps being transcribed and extracted
        while a level is being voiced. The text is taken from the node
        server-side, so the browser never needs the API key."""
        level = int(msg.get("level") or 2)
        node = _find_node(state["graph"], msg.get("node_id"))
        if not node:
            await ws.send_json({
                "type": "error", "node_id": msg.get("node_id"), "context": "speak_level",
                "message": "unknown node for speak_level",
            })
            return
        text = {1: node.get("analogy"), 3: node.get("deep")}.get(level) or node.get("definition") or node["label"]
        if not state["api_key"]:
            await ws.send_json({
                "type": "error", "node_id": node["id"], "context": "speak_level",
                "message": "No ElevenLabs API key configured.",
            })
            return
        try:
            filename, cached = await speak_level(
                node["label"], level, text, state["api_key"], force=msg.get("force", False)
            )
            await ws.send_json({
                "type": "audio", "node_id": node["id"], "level": level,
                "audio_url": f"/audio/{filename}", "cached": cached,
            })
        except Exception as e:
            await ws.send_json({
                "type": "error", "node_id": node["id"], "context": "speak_level",
                "message": f"speech generation failed: {str(e)[:200]}",
            })

    async def receive_loop():
        while True:
            msg = await ws.receive_json()
            msg_type = msg.get("type")

            if msg_type == "ask":
                await handle_node_action(
                    msg, "ask",
                    run=lambda node: answer_question(node["label"], node.get("definition", ""), msg.get("question", "")),
                    ok_payload=lambda node, answer: {
                        "type": "answer", "node_id": node["id"],
                        "question": msg.get("question", ""), "answer": answer,
                    },
                )
                continue

            if msg_type == "generate_image":
                await handle_node_action(
                    msg, "generate_image",
                    run=lambda node: generate_image(node["label"], node.get("definition", ""), force=msg.get("force", False)),
                    ok_payload=lambda node, result: {
                        "type": "image", "node_id": node["id"], "image_base64": result[0], "cached": result[1],
                    },
                )
                continue

            if msg_type == "explain_deep":
                await handle_node_action(
                    msg, "explain_deep",
                    run=lambda node: explain_deep(node["label"], node.get("definition", ""), force=msg.get("force", False)),
                    ok_payload=store_deep,
                )
                continue

            if msg_type == "select_node":
                state["selected_node_id"] = msg.get("node_id")
                continue

            if msg_type == "speak_level":
                asyncio.create_task(handle_speak_level(msg))
                continue

            if msg_type == "generate_widget":
                await handle_node_action(
                    msg, "generate_widget",
                    run=lambda node: generate_widget(node["label"], node.get("definition", ""), force=msg.get("force", False)),
                    ok_payload=lambda node, result: {
                        "type": "widget", "node_id": node["id"], "html": result[0], "cached": result[1],
                    },
                )
                continue

            if msg_type == "elevenlabs_key":
                key = (msg.get("key") or "").strip()
                if key != state["api_key"]:
                    await stop_transcriber(commit=False)  # next chunk reopens with the new key
                    state["api_key"] = key or ELEVENLABS_API_KEY
                await send_stt_status()
                continue

            if msg_type == "audio_chunk":
                if not state["api_key"]:
                    await ws.send_json({
                        "type": "error", "context": "no_key",
                        "message": "No ElevenLabs API key on this machine - paste one to transcribe.",
                    })
                    continue
                if state["stt"] is None:
                    try:
                        transcriber = RealtimeTranscriber(
                            state["api_key"], on_partial, on_committed, on_stt_error
                        )
                        await transcriber.start()
                        state["stt"] = transcriber
                    except Exception as e:
                        await ws.send_json({
                            "type": "error", "context": "transcribe",
                            "message": f"could not start ElevenLabs transcription: {str(e)[:200]}",
                        })
                        continue
                try:
                    await state["stt"].send_audio(msg.get("audio_base_64", ""))
                except Exception as e:
                    await stop_transcriber(commit=False)
                    await ws.send_json({
                        "type": "error", "context": "transcribe",
                        "message": f"transcription stream dropped: {str(e)[:200]}",
                    })
                continue

            if msg_type == "audio_stop":
                await stop_transcriber(commit=True)
                continue

            if msg_type == "generate_video":
                asyncio.create_task(handle_generate_video(msg))
                continue

            if msg_type == "generate_check":
                await handle_node_action(
                    msg, "generate_check",
                    run=lambda node: generate_check_question(node["label"], node.get("definition", "")),
                    ok_payload=lambda node, question: {
                        "type": "check_question", "node_id": node["id"], "question": question,
                    },
                )
                continue

            if msg_type == "generate_quiz":
                state["busy"] = True
                try:
                    questions = generate_quiz(state["graph"])
                    await ws.send_json({"type": "quiz", "questions": questions})
                except Exception as e:
                    await ws.send_json({"type": "error", "context": "generate_quiz", "message": f"quiz generation failed: {str(e)[:200]}"})
                finally:
                    state["busy"] = False
                continue

            if msg_type == "generate_summary":
                state["busy"] = True
                try:
                    summary = generate_summary(state["graph"])
                    await ws.send_json({"type": "summary", "summary": summary})
                except Exception as e:
                    await ws.send_json({"type": "error", "context": "generate_summary", "message": f"summary generation failed: {str(e)[:200]}"})
                finally:
                    state["busy"] = False
                continue

            if msg_type == "manual_text":
                # kept separate from the speech transcript: with ElevenLabs the
                # server owns `transcript`, so letting the text box overwrite it
                # would wipe everything already transcribed.
                state["manual"] = msg.get("text", "")
                if msg.get("force"):
                    force_event.set()
                continue

            # default: bare `{text}` transcript update, for scripts/tests that
            # push a transcript straight in without going through the mic
            state["transcript"] = msg.get("text", state["transcript"])
            if msg.get("force"):
                force_event.set()

    async def run_extraction(transcript: str) -> bool:
        """Returns True on success, False on error (caller uses this to back off)."""
        state["last_extracted"] = transcript
        try:
            graph = extract_flowchart(transcript, state["graph"])
        except Exception as e:
            await ws.send_json({"type": "error", "message": str(e)[:300]})
            return False
        state["graph"] = graph
        if graph.get("nodes"):
            await ws.send_json({"type": "diagram", "data": graph})
        else:
            await ws.send_json({"type": "empty"})
        return True

    async def extraction_loop():
        backoff_skips_remaining = 0
        while True:
            forced = False
            try:
                await asyncio.wait_for(force_event.wait(), timeout=EXTRACTION_INTERVAL_SECONDS)
                forced = True
            except asyncio.TimeoutError:
                pass
            force_event.clear()

            transcript = (state["transcript"] + " " + state["manual"]).strip()
            if not transcript:
                continue

            if state["busy"] and not forced:
                continue  # a user action (ask/image/widget) is running - don't queue behind it

            if backoff_skips_remaining > 0 and not forced:
                backoff_skips_remaining -= 1
                continue

            if not forced and transcript == state["last_extracted"]:
                continue  # nothing new since last pass, skip the Gemini call

            state["busy"] = True
            try:
                ok = await run_extraction(transcript)
            finally:
                state["busy"] = False
            backoff_skips_remaining = 0 if ok else MAX_BACKOFF_SKIPS

    try:
        await asyncio.gather(receive_loop(), extraction_loop())
    except WebSocketDisconnect:
        pass
    finally:
        await stop_transcriber(commit=False)
