# 5-minute pitch — one speaker, for the whole team

Read at ~150 wpm. Timings cumulative. **Bold** = land it. *Italic in
brackets* = stage direction, don't say it.

Before you walk up: pre-warm Rigour and the audio on your demo card, get the
first cards on screen, have the recorded clip open in another window.

---

## [0:00–0:40] The wedge

> Half of UK undergraduates no longer attend all their classes. It was 63% in
> 2006. It's 48% today.
>
> That isn't laziness. It's arithmetic.
>
> The recording can be paused. Rewound. Played at double speed. The room
> can't do any of those things. So showing up live now buys you **less** than
> staying in bed — and students did the maths before we did.
>
> Attendance is still the single best predictor of grades we have. Better
> than the SAT. Better than high-school GPA. And we've spent fifteen years
> making it rational to skip.

## [0:40–1:05] The claim

> We're making live attendance **mechanically** matter again.
>
> This is not a note-taking tool. It's a companion artifact that can only be
> built while you're physically in the room — because it reacts to *you*,
> mid-lecture, while the lecture is still changeable.
>
> Let me show you.

## [1:05–2:45] Demo

*Talk continuously. Never debug on stage — take the fallback and keep moving.*

> **[1:05]** I hit start, and I talk like a lecturer.
>
> *Speak 2-3 sentences of real content. Fallback: paste the clipboard
> paragraph, say "same pipeline — this is the path we test against."*
>
> **[1:20]** Concepts — not sentences — start landing as cards, and they
> arrange themselves into a radial hierarchy. This is a knowledge map, not a
> transcript.
>
> *Click Fit to view. Cannot fail.*
>
> **[1:45]** Now the part that matters. Every concept exists at three
> comprehension levels at once.
>
> *Click a card. Click Intuition, then Mechanism.*
>
> Level one, Intuition: what is this like? Level two, Mechanism: how does it
> actually work? **Switching costs zero API calls — the card already holds
> them.**
>
> **[2:05]** Level three, Rigour: what would a professor grill you on?
>
> *Click Rigour — pre-warmed, so instant. Fallback: go back to Mechanism, say
> "that one's generated and we're on a free-tier key; the two that matter are
> instant."*
>
> **[2:20]** And each level speaks back in a different voice — warm and slow
> for Intuition, fast and dense for Rigour. You *hear* which altitude you're
> at.
>
> *Play 4 seconds. Stop it. Fallback: say the line, move on.*
>
> **[2:30]** But I don't have to click anything. I'm in a lecture. So I
> mutter:
>
> *Say clearly: "explain that simpler." Card drops to Intuition.*
>
> *Fallback: click the Intuition tab immediately and say "you can also just
> say 'explain that simpler' — regex, no LLM, runs on every committed
> segment." **Do not repeat the phrase hoping it lands.***
>
> **[2:40]** And the whole map at once —
>
> *Change the topbar selector to 1 · Intuition. Every card re-levels. Cannot
> fail — pure memory.*
>
> — **the entire lecture, re-explained, instantly, for free.**

## [2:45–3:30] Why the recording can't do this

> Because the artifact is a function of **you being in the room**, not of the
> audio. Three mechanisms, all in the code today.
>
> **One.** It reacts to your confusion at the moment of confusion. You say
> "explain that simpler" while the lecturer is *still on that slide* — before
> the next concept lands on top of it. Watching a recording, that resolves
> twelve hours later. Usually never.
>
> **Two.** The room contains information the recording doesn't. The asides.
> The "this always comes up in the exam." The answer to someone else's
> question. The thing drawn on the board and never posted. That's the highest
> value five percent of a lecture, and it's systematically the part that
> doesn't survive.
>
> **Three.** This flips the incentive. Before: attending costs you a commute
> and gives you a worse version of the recording. After: attending is the
> only way to get a levelled, interrogated, voice-driven map of that specific
> hour.

## [3:30–4:10] How it's built

> One FastAPI backend, one WebSocket, vanilla JavaScript, no build step. Runs
> off a single laptop.
>
> Speech is transcribed live in the browser, with ElevenLabs Scribe taking
> over for tab audio or any browser without on-device recognition. Concepts
> are extracted by Gemini against the map already built, so the graph grows
> and never loses what it had. Every generated level, every voice clip is
> cached by concept — so the second student to hit "gradient descent" gets it
> instantly, and free.
>
> And here's the part I like. **This whole thing is voice-controlled — and we
> built it by voice, while running.** Nobody on this team touched a keyboard
> sitting down today. The product and the way it was made are the same shape.

## [4:10–4:40] What we're not claiming

*Say this. Judges trust the team that volunteers its own limits.*

> Three honest things.
>
> It's one day old and we have **zero** learning-outcome data. We know what
> experiment we'd run — same lecture, two cohorts, compare recall at two
> weeks — we just haven't run it.
>
> Nothing technically stops you pointing this at a recording. You'd get a
> summary. In the room, you get a dialogue. Those are different products, and
> only one requires you to have been there.
>
> And it's one laptop, one listener. The shared-room version — everyone
> building one map together — is the obvious next thing and the thing this
> architecture can't do yet.

## [4:40–5:00] Close

> We stopped arguing with students about whether to attend.
>
> We just made the room worth more than the recording.
>
> Thank you.

---

## If you're running long

Cut in this order: the [3:30] build section down to two sentences → the
[4:10] third limitation → the [0:00] statistics down to just "48% today."
**Never cut the demo or the three levels.**

## If the demo dies completely

Switch to the recorded clip and narrate over it with the same words. Say
once, plainly: "that's the live one failing on a free-tier key — here's the
run from twenty minutes ago." Then keep going. Do not apologise twice.
