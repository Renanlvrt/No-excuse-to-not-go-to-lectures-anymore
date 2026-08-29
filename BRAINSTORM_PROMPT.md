Paste this into any other AI chat to get fresh feature ideas.

---

I'm building "Lecture → Living Mind-Map" for a hackathon (RUN/HACK, London,
themed around building while running). Help me brainstorm ambitious but
buildable addon features.

**What it already does:**
- Browser mic (or pasted text) captures a live lecture
- Every ~20s, an LLM (Gemini) reads the growing transcript + the concept
  map already built, and returns the *complete* updated map (new concepts
  added, old ones never deleted, ids reused so nothing duplicates)
- Renders as a physics-based (d3-force), pannable/zoomable mind-map of
  color-coded cards - one card per concept, connected by labeled edges
- Click a card → opens a big right-side panel: full definition, an animated
  step-by-step walkthrough for process-type concepts (numbered circles,
  not a boring list), AI Q&A specific to that concept (persists), an
  on-demand illustrative image, and the flagship feature: a button that has
  the LLM write a *real interactive simulation* (self-contained HTML/JS -
  e.g. click to add data points and watch a regression line re-fit live,
  or step through a sorting algorithm) rendered in a sandboxed iframe
- Every generated simulation/image is cached forever by concept name -
  first time costs an API call, every time after (any lecture, any user)
  is instant and free
- "Fit to view" button, dark mode, reconnect-on-drop, manual text-paste
  fallback if the mic ever fails

**Constraints to respect in your ideas:**
- Free-tier API budgets are tight and have already been hit mid-demo once -
  ideas should be mindful of API call volume, or explicitly note when
  something needs a paid tier
- Stack: Python/FastAPI + WebSocket backend, vanilla JS (no framework) +
  d3-force frontend, Gemini for text/image, an ElevenLabs key exists but
  needs Pro for image/video (free tier confirmed blocked via a real 402)
- One runner, one browser tab is the primary use case (not built for many
  concurrent users)
- Has to be demo-able and understandable in a short judged walkthrough

**What I want from you:**
Brainstorm concrete addon features - the more creative and varied the
better. For each idea, briefly note: what it'd actually do, why it'd be
compelling in a demo, and how hard/risky it'd be to build in a short
remaining window. Prioritize ideas that are genuinely different from what's
listed above, not small variations on the same thing.
