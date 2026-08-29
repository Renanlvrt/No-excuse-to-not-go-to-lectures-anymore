# Pitch Handoff — Lecture → Living Mind-Map
*(Paste this whole file into ChatGPT or any other AI to help sharpen the pitch.)*

## Instructions for the AI reading this
This is a hackathon team handing you their project to help with the
**pitch**, not the code. Read everything below, then give back:
1. A tightened 60–90 second pitch script.
2. 15+ ranked ideas (effort vs. impact) to strengthen the demo/pitch
   before judging — a seed list is included below, expand/critique it.
3. Sharpest possible answer to: how does this product make **live
   attendance** mechanically better than just watching a recording
   later? That's the core wedge — push hard on it.
4. Anything a skeptical judge would attack, and how to defend it.

## The problem
Fewer students go to lectures in person. Recordings, slides posted
online, and 2x playback all remove the reason to physically show up —
attendance has been declining across universities for years. This
isn't a discipline problem, it's an **incentive** problem: right now
showing up live gives a student *nothing* a recording doesn't already
give them, and arguably less (can't pause, can't rewind, can't get an
instant follow-up).

## The idea / why it's original
This app turns a lecture, live, into a **growing interactive
mind-map** as the professor talks: color-coded concept cards, instant
AI Q&A per concept, on-demand images/videos/interactive widgets,
auto-generated quizzes. The pitch angle: it's not a note-taking tool
you could apply after the fact to a recording — it's a **live
companion artifact** that only exists because you were there,
listening, in real time. It makes "I'll just watch the recording
later" a worse deal than actually attending.

## Proof it already works (not just a slide deck)
- Full MVP running end-to-end, tested live today: speech/text →
  Gemini → real diagram nodes returned over WebSocket.
- Verified (Playwright-checked, see `SUCCESS_CRITERIA.md`): never-loses
  earlier concepts across extraction cycles, color-coded cards, real
  CSS 3D flip with definitions, physics-based no-overlap layout at 15+
  nodes, pan/zoom, animated multi-step process walkthroughs.
- Extra features already coded: per-concept image generation, teaching
  video generation, interactive widgets, quiz generation, summary
  generation.

## Tech stack (for feasibility/judging)
FastAPI + one WebSocket endpoint (`/ws/lecture`) driving everything,
Gemini for concept extraction/Q&A (temporary — swapping providers
later), vanilla JS + `d3-force` physics on canvas (no frontend build
step), runs on one laptop via a single `start.ps1`.

## What we're optimizing the pitch for
Hackathon judging usually weighs: **originality**, **creativity**,
**usefulness / would-people-actually-use-this**, and demo polish. Lead
with the "live attendance actually matters again" hook — that's the
most original, most memorable claim we can make.

## Seed ideas to improve the pitch / product (expand and critique these)
**Make live attendance mechanically necessary (the sharpest hook):**
1. Certain nodes (professor asides, live Q&A, board-only content) only
   get captured if you were listening live — a recording watched later
   can't reconstruct the same timing/emphasis-driven graph.
2. Multiplayer canvas: everyone in the room builds one shared live map
   together (WebSocket room) — a group artifact you can only join live.
3. Cross-check: multiple students' live maps in the same room merge to
   auto-fill gaps — an actual reason to bring friends to lecture.
4. "You were here" recap card at the end (opt-in), showing live
   engagement — something a professor could actually want to see.

**Engagement / learning value:**
5. Spaced-repetition next-day quiz pulled from yesterday's map (quiz
   generation already exists — just needs a "come back tomorrow" hook).
6. "Explain it back" mode: record yourself explaining a node, AI grades
   it (Feynman technique).
7. Cross-lecture linking: a concept that reappears in a later lecture
   auto-links into one running personal knowledge graph across a term.
8. Anonymized "commonly confusing" heat-map surfaced back to the
   professor from a whole class's live sessions.

**Demo polish (protect the pitch on stage):**
9. Record a 30s backup clip of a perfect run in case live mic/Wi-Fi
   fails during the actual demo — never live-demo speech recognition
   with no fallback.
10. Walk through image + video + quiz + widget generation live on
    stage — that's the "wow" most other teams won't have.
11. Dark/light toggle for projector visibility.
12. One-click export of the finished map as a shareable page/PDF —
    "better notes than you could type, and you get them for free."

**Roadmap beyond the hackathon (shows judges this isn't a dead end):**
13. Swap Gemini for a different/cheaper long-term provider (already
    planned).
14. LMS integration (Canvas/Moodle) — auto-post the map after class.
15. Accessibility framing: real-time visual structure helps
    neurodivergent, ESL, and hard-of-hearing students far more than a
    static recording — strong, judge-friendly "usefulness" angle.

## Open questions for you to weigh in on
- Is "make attendance matter again" too niche, or is it the strongest
  possible hook vs. a generic "AI note-taking app" pitch?
- Which 3 of the seed ideas above are actually buildable before
  judging, given this is a live-running hackathon (team is literally
  coding while running)?
