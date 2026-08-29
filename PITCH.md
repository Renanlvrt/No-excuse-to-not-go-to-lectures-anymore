# PITCH.md — Lecture → Living Mind-Map

Pitch at 19:00. Everything below describes only what is actually in the code
today (verified against `README.md`, `HANDOVER.md`, `SUCCESS_CRITERIA.md`,
`CLAUDE.md` and the source). Claims that are *not* verified are flagged as
such — do not upgrade them on stage.

**One-line hook:** *"Attendance is falling because sitting in the room gives
you strictly less than the recording. We make being in the room the only way
to get the artifact."*

---

## 1. Spoken pitch script (60–90s, read aloud)

Marked timings are cumulative. Read at ~150 wpm. Total ≈ 82s.

> **[0:00–0:12] The wedge**
> Half of UK undergraduates no longer attend all their classes — that's down
> from 63% in 2006 to 48% in 2025. It isn't laziness. It's arithmetic. The
> recording can be paused, rewound, played at 2x. The room can't. Showing up
> live now buys you *less* than staying in bed.
>
> **[0:12–0:26] The claim**
> We're making live attendance mechanically matter again. This is not a
> note-taking tool. It's a companion artifact that can only be built while
> you are physically in the room, listening in real time — because it reacts
> to *you*, mid-lecture, while the lecture is still changeable.
>
> **[0:26–0:48] What it is**
> Speak — or let the lecturer speak — and ElevenLabs Scribe streams the room
> into a semantic knowledge map that grows as the concepts arrive: a radial
> hierarchy, not a wall of text. Every concept exists at three comprehension
> levels at once. Level one, Intuition: what is this like? Level two,
> Mechanism: how does it work? Level three, Rigour: what would a professor
> grill you on? Switching levels costs zero API calls — the map already
> holds them.
>
> **[0:48–1:04] The bit only live gets you**
> And you drive it with your voice. Mutter "explain that simpler" under your
> breath and the card you're looking at drops to Intuition. Say "go deeper"
> and it goes to exam-level Rigour. Each level speaks back in a different
> voice — warm and slow for Intuition, fast and dense for Rigour — so you
> hear which altitude you're at.
>
> **[1:04–1:15] Why the recording can't do that**
> That loop is the product. A recording can be summarised. It cannot be
> *interrogated at the moment you were confused*, by a system that heard the
> aside the lecturer only said once, in the room, and never put on a slide.
> The map you walk out with is proof you were there — and it is better than
> the map anyone gets from the recording.
>
> **[1:15–1:22] Close**
> Attendance predicts grades better than any admissions test we have. We
> stopped arguing with students about attending and gave them a reason to.

*(If you're running long: cut the [0:48] voice-playback sentence and the
[1:15] statistic. The wedge and the three-levels demo are the pitch.)*

---

## 2. Live demo running order (90s, click-by-click)

Do this in Chrome at `http://localhost:8010/static/index.html`, window
maximised, dark background is fine (the app is `prefers-color-scheme` aware).

**Pre-stage checklist (before you walk up — not part of the 90s):**
- App running, websocket connected, status line not showing an error.
- `.env` has both `GEMINI_API_KEY` and `ELEVENLABS_API_KEY` on *this*
  laptop; if not, paste the ElevenLabs key into the key box the UI shows.
- A ~700-character lecture paragraph in your clipboard (the fallback fuel).
- **A screen recording of a good run, playable in one click.** If the Wi-Fi
  or a quota dies, this is the whole demo. `HANDOVER.md` ranks this as the
  #2 priority for a reason.
- Two or three cards already generated and left on screen is *acceptable*
  and safer than an empty map — you can still show growth on top of it.

| # | Time | Action | If it fails |
|---|------|--------|-------------|
| 1 | 0:00–0:08 | Click **▶ Start listening**. Speak 2–3 sentences of real lecture content ("A hash map trades memory for constant-time lookup by…"). Point at the live transcript filling in. | Transcript stays empty → stop talking, paste the clipboard paragraph into the **"Type/paste lecture text here"** box. Say the line out loud: *"same pipeline, this is the path we test against."* Don't debug the mic on stage. |
| 2 | 0:08–0:25 | Keep talking while the first cards appear and the radial map lays itself out. Say what's happening: concepts, not sentences. | No cards after ~15s → paste text (as above). If still nothing, cut to the recorded clip and narrate over it. |
| 3 | 0:25–0:32 | Click **🔍 Fit to view** so the whole map is legible from the back of the room. | Purely client-side, cannot fail. |
| 4 | 0:32–0:50 | Click one card. In the right panel click through the **Intuition → Mechanism** level tabs. Emphasise: *"zero API calls, this is already on the card."* | Cannot fail — both are in-memory text. This is your safest wow, which is why it's early. |
| 5 | 0:50–1:02 | Click the **Rigour** tab (one Gemini call, cached by concept). | Error toast → switch back to Mechanism and say *"that one's a generated tab and we're on a free-tier key; the two that matter are instant."* Pick a card you already generated Rigour for pre-stage — the cache makes it instant and free. **Do this: pre-warm Rigour on your demo card.** |
| 6 | 1:02–1:12 | Click **🔊 Read it to me**. Let 4–5 seconds of the level's voice play, then stop it. Mention the voice changes per level. | No audio → say the line and move on. Pre-warm this too: cached audio is served from disk, no API call. |
| 7 | 1:12–1:22 | The voice-control beat: with a card selected, say clearly *"explain that simpler"* and let the panel drop to Intuition. | It doesn't fire, or fires on the wrong card → immediately click the Intuition tab instead and say *"you can also just say 'explain that simpler'; regex, no LLM, runs on every committed segment."* Do **not** repeat the phrase hoping it lands. |
| 8 | 1:22–1:30 | Change the topbar **Whole map** selector to `1 · Intuition` — the entire map re-levels at once. Land the closing line here. | Cannot fail — in-memory. |

**Deliberately NOT in the 90s** (have them ready as answers to "what else",
don't spend demo time on them): 🧩 interactive simulation generation
(~12s Gemini call — great, too slow for stage), 🖼️ image generation (a
successful render is *unconfirmed*, quota was exhausted in testing —
`SUCCESS_CRITERIA.md` #8), 📝 Quiz me, 🎁 Wrap up summary, ElevenLabs video
(402-blocked on free tier — never mention it as working).

---

## 3. The sharpest answer: why is live mechanically better than the recording?

Say this, in this order:

**"Because the artifact is a function of you being in the room, not of the
audio."**

Three concrete mechanisms, all in the code today:

1. **It reacts to your confusion at the moment of confusion.** The map is
   built off the *live* stream and driven by your voice mid-lecture. Say
   "explain that simpler" while the lecturer is still on that slide, and
   you get the Intuition-level version *before* the next concept lands on
   top of it. That closes the loop at the only moment it's cheap to close:
   while the lecturer is still in front of you and can be asked. Watching
   a recording, confusion resolves twelve hours later, if at all.
2. **The room contains information the recording does not.** The graph is
   built from what was actually *said* — asides, the "this always comes up
   in the exam", the answer to another student's question, the thing drawn
   on the board and never posted. Those are the highest-value 5% of a
   lecture and they are systematically the parts that don't survive to the
   slides or, often, to a mic-on-the-podium recording.
3. **Attending now produces a better study asset than not attending.** This
   is the incentive flip. Before: attendance costs you a commute and gives
   you a worse version of the recording. After: attendance is the only way
   to get a levelled, interrogated, voice-driven concept map of that
   specific hour. Attendance is the best-known predictor of grades (ρ ≈
   .44 with class grades, better than SAT or high-school GPA — Credé et al.
   2010), and lecture-capture availability has been shown to *reduce*
   attendance and, through it, attainment (Edwards & Clinton 2019). We're
   not moralising about that trade; we're changing what's on each side of
   it.

**The honest one-sentence version:** *nothing stops you pointing this at a
recording — but if you do, you get a summary. If you're in the room, you get
a dialogue. Those are different products, and only one of them requires you
to have been there.*

---

## 4. Six toughest judge questions

**Q1. "Isn't this just Otter or NotebookLM plus a graph?"**
Overlap is real and we won't pretend otherwise: Otter does live
transcription, NotebookLM generates mind maps. Both are *retrospective* —
you give them a corpus and they give you back an artifact. Neither is
steerable by your voice while the source event is still happening, and
neither carries three simultaneous comprehension levels per concept where
two of them are free to switch. Our unit isn't a document, it's a concept
node with an altitude dial, built during the event. That's a different
interaction, not a prettier output.

**Q2. "Why won't students just run it on the recording?"**
They can, and it'll work — same pipeline, we ship a paste-text box.
They'll get a worse artifact: no voice-driven levelling at the moment of
confusion, no asides the mic-on-the-podium didn't capture, and no chance to
ask the human. We're not building a moat out of technical prevention, we're
building one out of output quality: the live map is strictly better than the
post-hoc map. That's the honest version of the wedge, and it's the version
that survives contact with a determined student.

**Q3. "What happens when the API quota runs out on stage?"**
Partly designed for, partly a real risk, and here's exactly where the line
is. Every text call goes through a model-fallback chain
(`backend/services/llm.py`) because separate Gemini model names have
separate free-tier pools — that has already saved one live demo. TTS and
Rigour text are cached by concept and served from disk, so anything we
pre-warm costs zero calls. Levels 1 and 2, the whole-map level selector,
layout, pan/zoom and flip are 100% client-side and cannot be rate-limited.
What genuinely dies with the quota is fresh concept extraction, and our
answer there is a recorded backup run, not a claim that it can't happen.

**Q4. "Does this improve learning outcomes, or is it a nicer-looking
distraction?"**
We have no outcome data. Zero. It's a hackathon build from today, and
anyone claiming otherwise about a one-day project is lying to you. What we
have is a design that leans on findings that *are* established: attendance
is the strongest known behavioural predictor of grades (Credé 2010);
retrieval practice and generation reliably beat re-reading (Agarwal et al.
2021 review); and lecture capture measurably displaces attendance (Edwards
& Clinton 2019). The distraction risk is the right question to ask, and
it's why levelling is one click and costs nothing — the fastest possible
interaction — and why nothing generates automatically. The honest test is a
term-long A/B against a control cohort, and that's the first thing we'd
want funding to run.

**Q5. "The lecturer's own voice is in the same mic. Doesn't it fire
commands on the lecture itself?"**
It did, and that's now fixed — worth knowing exactly how, because it's the
sharpest bit of engineering in the build. `intent.py` is a local regex, not
an LLM call, because it has to run on every committed segment for free
without queueing behind extraction. The problem is that the lecture's
vocabulary *is* the trigger vocabulary — "proof", "intuition",
"mechanism", "deeper". So a bare topic word never fires. A match needs an
*addressed command*: an imperative anchored at the start of the sentence
("explain that simpler", "go deeper", "give me the proof"), or a first/
second-person complaint ("I don't get it", "you lost me"). "We go deeper
into this next week" and "this proof is rigorous" are lecture, and return
None. Residual risk is now the other direction — phrasing it didn't
anticipate silently does nothing — which is why the level tabs are always
one click away. A push-to-talk key is the real long-term answer.

**Q6. "Does this actually scale, or is it one laptop?"**
One laptop, today, honestly. Every Gemini call runs inline on the single
event loop — threads deadlock on the demo machine's cert stack, which is
documented and deliberate, not an oversight. That's fine for one listener
and wrong for a lecture hall. The fix is known (subprocess or proper async
workers, and the per-concept cache already means the second student in the
room asking for the same node's Rigour text costs nothing). The
multiplayer version — one shared map per room, built by everyone present —
is the actually interesting product, and it's the thing the architecture
was pointed at, not something we're claiming we shipped.

*(Bonus, if privacy comes up: yes, you're recording a lecturer. The
ElevenLabs key never reaches the browser — audio goes browser → our
websocket → ElevenLabs — but institutional consent is a real deployment
blocker, not a solved problem. Say that plainly if asked.)*

---

## 5. Competitive & market research

### Verified — checked today, quotes/links below

**In-person attendance is genuinely declining (UK, longitudinal):**
- HEPI / Advance HE, *What Matters Most? 20 years of the student experience*
  (2026): undergraduates attending **all** scheduled classes fell from
  **63% (2006) to just under 48% (2025)**; average timetabled teaching
  missed **more than doubled**, ~1 hr/week (2006) → **2.4 hrs/week (2025)**
  out of 15.2 scheduled; among students who miss anything, the average is
  **5.0 hrs/week ≈ one-third of their timetable**. Report drivers cited:
  paid term-time employment, and *"more accessible tech enables some online
  catch up"*.
  https://www.hepi.ac.uk/reports/what-matters-most-20-years-of-the-student-experience/
  Coverage: https://www.timeshighereducation.com/news/students-missing-twice-much-teaching-time-20-years-ago
- *Understanding lecture and tutorial absenteeism in higher education*,
  International Review of Economics Education (2026): "Student attendance
  in higher education has declined substantially in recent years", and
  compares lecture vs tutorial patterns.
  https://doi.org/10.1016/j.iree.2026.100353

**Attendance matters for outcomes:**
- Credé, Roch & Kieszczynka, *Class Attendance in College: A Meta-Analytic
  Review* (Review of Educational Research, 2010): attendance ↔ class grades
  **ρ = .44** (k=69, N=21,195) and GPA **ρ = .41** (k=33, N=9,243) — "a
  better predictor of college grades than any other known predictor …
  including SAT, high school GPA, study habits and study skills."
  https://journals.sagepub.com/doi/10.3102/0034654310362998

**Lecture capture can actively displace attendance:**
- Edwards & Clinton, *A study exploring the impact of lecture capture
  availability and lecture capture usage on student attendance and
  attainment* (Higher Education, 2019; matched cohorts N=161 / N=160):
  attendance "substantially dropped" after capture was introduced;
  attendance **mediates a negative relationship between capture
  availability and attainment**; capture viewing showed **no significant
  relationship with attainment** once attendance was controlled, and
  "fails to compensate" for low attendance. Net effect described as
  "generally negative."
  https://doi.org/10.1007/s10734-018-0275-9 ·
  https://eric.ed.gov/?id=EJ1207072
  *(This is the single most useful citation in the deck: the incumbent
  category has measured harm.)*

**Learning-science backing for active over passive (supports the design,
does NOT evidence our product):**
- Agarwal et al., *Retrieval Practice Consistently Benefits Student
  Learning: a Systematic Review of Applied Research in Schools and
  Classrooms* (Educational Psychology Review, 2021): 50 coded classroom
  experiments, 49 effect sizes, n=5,374, **57% showed medium or large
  benefits**. https://link.springer.com/article/10.1007/s10648-021-09595-9
- Karpicke, *Practicing Retrieval Facilitates Learning* (Annual Review of
  Psychology, 2021). https://www.annualreviews.org/content/journals/10.1146/annurev-psych-010419-051019

**Incumbents / adjacent products (features confirmed from vendor pages):**
| Product | What it does | Where we differ |
|---|---|---|
| **Otter.ai** | Real-time transcription, live notes/captions, AI chat over the transcript, auto-joins Zoom/Teams/Meet. Free tier 300 min/mo; Pro ~$16.99/user/mo list. [pricing](https://home.otter.ai/pricing) | Meeting-shaped: a transcript plus a summary. No concept graph, no comprehension levels, not voice-steerable during the event. |
| **Google NotebookLM** | Mind Maps, Audio Overviews, Video Overviews (narrated slides), Reports — generated from uploaded sources. [Google blog](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-video-overviews-studio-upgrades/) | Strictly post-hoc: you upload a corpus, it produces artifacts. Nothing is built *while* the lecture happens; no live steering. This is the closest comparison and the one to name first, before a judge does. |
| **Glean** (glean.co) | Purpose-built student lecture capture: record class, quick highlights, structured review workflow, AI "Quiz Me". Claims 700+ institutions. [student booklet](https://glean.co/hubfs/Student%20Booklet%20-%202024.pdf) | Closest thing to a direct competitor in the *student* segment, and its whole model is "capture now, do the work later" — the exact behaviour we're arguing against. |
| **Panopto / Echo360** | Institutional lecture capture and video CMS; searchable recordings, LMS integration, campus-wide deployments. [Panopto HE](https://www.panopto.com/higher-education/industries/universities/) | These are the *cause* of the problem in the Edwards & Clinton finding, and the incumbent buyer relationship at every university. Position as distribution partner or as the thing being disrupted — pick one and stick to it. |

Note on vendor claims: Panopto's own marketing cites "98% of UW students
agreed Panopto contributed to their learning". That is vendor-collected
self-report and contradicts the peer-reviewed attainment finding — don't
cite it, and if a judge does, that's the contrast to draw.

### Inference / opinion — clearly not verified
- **Nobody appears to be selling "live, voice-steerable concept graph built
  during class."** We found no product doing this. That's an absence of
  evidence from ~20 minutes of searching, not evidence of absence — say
  "we didn't find one", never "there is no competitor".
- We did **not** find a UK/US market-size figure for student note-taking AI
  that we'd be willing to quote. **Do not invent one.** If asked to size
  it, reason bottom-up from something checkable instead (Glean's own
  "700+ institutions" claim is a defensible anchor).
- Whether students would *pay* for this vs. expect the university to buy it
  is untested. Institutional accessibility budgets (Glean's actual route
  into universities) look like the more plausible wedge, but that's a
  hypothesis.
- The claim that asides/board-only content are the highest-value part of a
  lecture is intuitive and we believe it, but we have no citation for it.
  Frame it as a claim, not a finding.

---

## 6. Things that WEAKEN the pitch — read before going on stage

Ranked by how likely they are to bite you.

1. **The wedge is philosophically soft: nothing technically stops the app
   being pointed at a recording.** The paste-text box literally accepts any
   text. Our defence is "the live artifact is better", not "the recording
   can't". If a judge pushes twice, concede the point cleanly (Q2) — a
   defensive answer here is worse than the concession.
2. **Voice-driven level switching is the most impressive beat and the one
   most likely to no-op live.** `intent.py` was tightened at ~16:50 to
   require an *addressed command* rather than a bare noun, which kills the
   false-trigger-on-the-lecturer problem but makes the matcher strict.
   **Rehearse the exact phrases that are in the pattern list** — "explain
   that simpler", "go deeper", "how does that actually work", "back to
   normal" all match; improvised paraphrases may not. It also only fires
   on a *committed* Scribe segment, so there's a second or two of lag.
   Have the click-the-tab fallback rehearsed; do not retry the phrase.
   (This change landed after the pitch was drafted and has not been
   exercised through real speech — verify it with the mic before stage.)
3. **Free-tier quota is a live single point of failure and has already
   failed once today** (all three image models exhausted during testing —
   `SUCCESS_CRITERIA.md` #8, README). Fresh extraction is the vulnerable
   path. Pre-warm everything cacheable; have the recorded clip ready.
4. **Nobody has confirmed a full end-to-end run with a real human speaking
   into a real mic since the last three features landed.** `HANDOVER.md`
   ranks this as priority #1 and it was still open at 16:15. Live mic →
   Scribe was verified with *synthesized* audio only. This is the single
   biggest demo risk on the list, and it is fixable in the next hour by
   somebody just doing it.
5. **The empty-map extraction loop still polls every 3s off a mutating
   partial transcript.** A 120-char minimum gate was added, but once you're
   past it and the map is still empty, it can issue many Gemini calls per
   minute against a ~10 RPM free tier — i.e. the worst case is exactly the
   first 30 seconds of your demo. Symptom looks like "I'm talking and
   nothing appears". Mitigation: get the first cards up *before* you're on
   stage, or seed with pasted text.
6. **Zero learning-outcome evidence, and the product is one day old.** Q4
   handles it, but if a judging rubric weights "usefulness" heavily,
   expect to lose points here regardless of the answer. Don't oversell —
   an honest "no data, here's the experiment we'd run" scores better than
   a hedge.
7. **Single-laptop architecture (every LLM call blocking on one event
   loop).** Fine for a demo, and the multiplayer story judges will
   naturally ask about is precisely what this architecture can't do yet.
8. **Sponsor framing risk.** README notes RUN/HACK's official sponsor list
   wasn't published when the app was built, and that ElevenLabs/Tavily were
   *guesses*. ElevenLabs is genuinely load-bearing in the code (Scribe +
   TTS), so that's safe to say. Tavily is not wired in at all — never imply
   it is. ElevenLabs **video** is 402-blocked on the free tier; never demo
   or claim it.
9. **Image generation has never been observed to succeed.** The mechanism
   and its failure path are verified; a successful render is not. Keep it
   out of the demo and out of the feature list you recite.
