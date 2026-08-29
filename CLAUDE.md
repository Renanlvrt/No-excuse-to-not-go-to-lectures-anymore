# Lecture → Living Mind-Map (hackathon MVP)

New AI agent starting a shift? Read this whole file — it's short on
purpose. Teammates rotate every ~30 min, so this must get you productive
fast.

## What this app does
Live speech (or pasted text) → Gemini extracts concepts → an
interactive, color-coded mind-map grows in real time on canvas. Details:
`README.md`. Full rebuild-from-scratch spec: `AI_HANDOFF/` (read
`00_START_HERE.md` first). Verified feature checklist: `SUCCESS_CRITERIA.md`.

## Run it
```powershell
.\start.ps1
```
Open `http://localhost:8010/static/index.html` in **Chrome**.
Needs a `.env` file (copy `.env.example`, fill in real keys — ask the
team, never invent placeholder keys and never commit real ones).

## Current LLM provider: Gemini (temporary)
`GEMINI_API_KEY` powers concept extraction now. This is a **deliberate
short-term choice** — the plan is to move off Gemini later (possibly to
ElevenLabs for the voice/agent side). Don't treat Gemini as a permanent
architectural decision; don't be surprised if a future shift swaps it out.

## Hard rules
1. **Commit + push after every change**: `git add -A && git commit -m "..." && git push`.
   Don't batch unpushed work — the team watches this repo live.
2. **Never commit secrets**: `.env` and `data/` are gitignored — keep it
   that way. If you ever add a new API key, add it to `.env.example`
   (name only, empty value) too.
3. **Replies to Renan must be short.** He's running on a treadmill while
   coding — can't read long text. Give the short answer, or a short
   question with 2-3 clickable recommended options. No preamble.

## Where things are
- `backend/main.py` — FastAPI app, one websocket (`/ws/lecture`) driving everything
- `backend/services/` — one file per capability (diagram, qa, imagegen, videogen, quizgen, summarygen, widgetgen, cache, llm, transcribe, enrich)
- `frontend/` — `index.html` + `app.js` + `style.css`, no build step
- `AI_HANDOFF/` — full PRD/decisions/prompts/source snapshot, for reproducing this app elsewhere from scratch
