"""Local, zero-cost matcher: does a spoken segment ask for another level?

Deliberately regex, not an LLM call: it must answer instantly on every
committed segment, cost nothing, and never queue behind the single blocking
Gemini slot that extraction already contends for.

The professor's voice is in the same stream, so this only fires on a SHORT
sentence (a student aside, not a sentence of lecture) that also carries an
explicit trigger phrase. A committed segment can now hold several sentences
(transcribe.py force-closes a segment every few seconds of continuous
speech), so each sentence is tested on its own - a long lecture sentence
sharing a segment with "go deeper" no longer masks the aside, and it still
can't trigger anything itself. The segment is appended to the transcript
that feeds extraction either way - a command is never swallowed.
"""
import re

MAX_TRIGGER_WORDS = 9  # a lecture sentence is longer than this; an aside isn't
SENTENCE_SPLIT = re.compile(r"[.!?,;]+")

PATTERNS = [
    (1, r"\b(simpler|simply|simplify|dumb (it|this|that) down|like i'?m five|eli5|"
        r"i don'?t (get|understand) (it|this|that)|lost me|too complicated|"
        r"what'?s the intuition|intuition)\b"),
    (3, r"\b(go deeper|deeper|more rigorous|rigorous|rigour|rigor|be precise|"
        r"more formal|formally|exam level|prove it|proof)\b"),
    (2, r"\b(how does (it|this|that) (actually )?work|mechanism|normal level|"
        r"back to normal|middle level)\b"),
]


def match_level_intent(segment: str) -> int | None:
    """Returns the requested comprehension level (1/2/3), or None."""
    for sentence in SENTENCE_SPLIT.split(segment.lower()):
        text = sentence.strip()
        if not text or len(text.split()) > MAX_TRIGGER_WORDS:
            continue
        for level, pattern in PATTERNS:
            if re.search(pattern, text):
                return level
    return None
