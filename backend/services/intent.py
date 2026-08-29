"""Local, zero-cost matcher: does a spoken segment ask for another level?

Deliberately regex, not an LLM call: it must answer instantly on every
committed segment, cost nothing, and never queue behind the single blocking
Gemini slot that extraction already contends for.

The lecturer's voice is in the same stream, and the lecture's own vocabulary
IS the trigger vocabulary ("proof", "intuition", "mechanism", "rigorous",
"deeper"). So a bare topic word never fires: a match needs an *addressed
command* - either an imperative/request aimed at the app ("explain that
simpler", "go deeper", "give me the proof", "what's the intuition"), anchored
at the start of the sentence so "we go deeper into this next week" cannot
match, or an explicitly first/second-person complaint ("I don't get it",
"you lost me"). "This proof is rigorous" and "the intuition here is simple"
are lecture, and return None.

A committed segment can hold several sentences (transcribe.py force-closes a
segment every few seconds of continuous speech), so each sentence is tested
on its own. The segment is appended to the transcript that feeds extraction
either way - a command is never swallowed.
"""
import re

MAX_TRIGGER_WORDS = 12  # an aside is short; a lecture sentence is not
SENTENCE_SPLIT = re.compile(r"[.!?,;]+")

# Filler an aside may open with. Deliberately excludes "so", "and", "but",
# "now", "then" - those are how a lecturer starts a rhetorical question.
_FILLER = r"(?:(?:hey|ok|okay|wait|sorry|erm|um|uh|hold on|hang on|actually|please)[\s,]+)*"
_REQUEST = r"(?:(?:can|could|would|will)\s+(?:you|we)\s+(?:please\s+)?|please\s+|just\s+)*"
# An imperative/request must open the sentence, after filler only.
COMMAND_PREFIX = rf"^{_FILLER}{_REQUEST}"

_SIMPLER = (r"(?:simpler|more simply|simply|in (?:really\s+)?simple[r]?\s+terms|"
            r"in plain english|like i'?m five|for a (?:beginner|five year old))")
_DEGREE = r"(?:a bit\s+|a little\s+|much\s+|way\s+|lot\s+|)"

# Imperatives / direct requests, anchored at the start of the sentence.
COMMANDS = [
    (1, rf"(?:explain|say|put|repeat|rephrase|word|do)\s+(?:that|this|it|the last (?:bit|part)\s*)?\s*"
        rf"(?:again\s+)?{_DEGREE}(?:more\s+)?{_SIMPLER}"),
    (1, rf"(?:go|be|keep it|make it)\s+{_DEGREE}(?:more\s+)?{_SIMPLER}"),
    (1, r"(?:simplify|unpack)\s+(?:that|this|it)\b"),
    (1, r"dumb (?:it|this|that) down"),
    (1, r"break (?:it|this|that) down"),
    (1, r"eli5|explain like i'?m five"),
    (1, r"(?:what|what'?s|whats)\s*(?:is\s+)?the intuition\b"),
    (1, r"(?:give|show) me the intuition\b"),
    (1, r"(?:i'?m|im) lost\b"),
    (3, rf"(?:go|dig|drill|take (?:it|this|that))\s+{_DEGREE}deeper\b"),
    (3, r"go into (?:more |much more )?depth\b"),
    (3, r"(?:go|be|get|make it)\s+(?:more |much more )?(?:rigorous|rigourous|precise|formal|technical)\b"),
    (3, r"(?:give|show) me (?:the|a|more) (?:full )?(?:proof|derivation|rig(?:our|or)|maths|math|detail)"),
    (3, r"prove (?:it|that|this)\b"),
    (3, r"(?:do|derive|walk me through) (?:the )?(?:proof|derivation)\b"),
    (3, r"(?:what|where)'?s the (?:proof|derivation)\b"),
    (3, r"(?:go|switch to|make it) (?:exam level|full rig(?:our|or))\b"),
    (2, r"how does (?:that|this|it) (?:actually |really |)work\b"),
    (2, r"(?:what|what'?s|whats)\s*(?:is\s+)?the mechanism\b"),
    (2, r"explain the mechanism\b"),
    (2, r"(?:go )?back to (?:normal|the normal level|the mechanism)\b"),
    (2, r"(?:normal|middle|mechanism) level\b"),
]

# Explicitly self/second-person asides: addressed by construction, so they
# may appear anywhere in the sentence.
ADDRESSED = [
    (1, r"\bi (?:really |totally |completely |just )?(?:don'?t|do not|can'?t) "
        r"(?:get|understand|follow|see) (?:it|this|that|any of (?:it|this|that)|you)\b"),
    (1, r"\bi'?m (?:completely |totally |so |a bit |)(?:lost|confused)\b"),
    (1, r"\byou(?:'ve| have)? lost me\b"),
    (1, r"\b(?:that|this|it)'?s too complicated (?:for me)?\b"),
    (1, r"\bi'?m not following\b"),
    (1, r"\bmakes no sense to me\b"),
    (3, r"\bi (?:want|need) (?:the|more) (?:proof|derivation|rig(?:our|or))\b"),
    (2, r"\bi don'?t see how (?:that|this|it) works\b"),
]

_COMPILED = [(level, re.compile(COMMAND_PREFIX + body)) for level, body in COMMANDS]
_COMPILED += [(level, re.compile(body)) for level, body in ADDRESSED]


def match_level_intent(segment: str) -> int | None:
    """Returns the requested comprehension level (1/2/3), or None."""
    for sentence in SENTENCE_SPLIT.split(segment.lower()):
        text = sentence.strip()
        if not text or len(text.split()) > MAX_TRIGGER_WORDS:
            continue
        for level, pattern in _COMPILED:
            if pattern.search(text):
                return level
    return None
