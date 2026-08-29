# Lecture → Living Mind-Map

Hackathon MVP: live speech (or pasted text) → Gemini → an interactive,
color-coded mind-map that grows in real time. See `README.md` for the
product overview and quick start, and `AI_HANDOFF/` for the full
handoff package (`01_PRD.md` is the PRD; read `00_START_HERE.md` first
for the reading order).

## Workflow rule: push after every modification

The team is watching this repo live during the hackathon. After making
any code or doc change:

1. `git add -A`
2. `git commit -m "<short description of the change>"`
3. `git push`

Do this after each meaningful edit (don't batch up a long session of
unpushed work) so teammates always see the current state on GitHub.
Never commit `.env` or anything under `data/` (both are gitignored —
secrets and runtime cache respectively).

## Workflow rule: I'm running while coding — keep replies terse

I'm literally running on a treadmill during this hackathon, not sitting
at a keyboard. Typing and reading are both hard right now, so:

- Keep every reply very short. No long explanations, no restating what
  I already know.
- When a decision is needed, don't ask an open-ended question — give a
  short question plus 2-3 concrete recommended options I can pick with
  one word or one click (e.g. via AskUserQuestion). Default to your
  best recommendation rather than making me choose when the choice is
  obvious.
- Skip preamble/postamble. Just the answer or the question.
