"""Generate a self-contained, interactive HTML/JS simulation for one concept.

User-triggered only (a button per node), same bounded-cost pattern as image
generation - but this uses the regular TEXT model chain (llm.py), not the
image-gen chain, so it's cheap and draws from the quota pool that's actually
working today. Rendered client-side in a sandboxed iframe (see frontend
app.js) - `sandbox="allow-scripts"` with NO `allow-same-origin`, loaded via
`srcdoc`, plus a CSP meta tag injected server-side (defense in depth against
network exfiltration, which `sandbox` alone doesn't block).

Prompting approach (researched): raw HTML only, single self-contained file,
zero external dependencies, a required-controls list, and hard safety bans
restated at the end (late instructions get weighted more heavily) - no
unbounded loops, every timer must have a working stop condition, wrap
everything in try/catch + a window.onerror fallback.
"""
import re
from backend.services.llm import generate_with_fallback
from backend.services.cache import get_cached, set_cached

CACHE_NAME = "widgets"

SYSTEM = """You write a single self-contained interactive educational HTML
widget that lets a student directly manipulate a concept from their lecture
to understand it - not a static diagram, an actual small simulation/toy they
can play with (add points, drag sliders, click to step through, type inputs
and see results). Think "a tiny interactive explainer a student could poke
at for two minutes and genuinely get it."

OUTPUT CONTRACT: output ONLY the raw HTML document, starting with
<!DOCTYPE html> and ending with </html>. No markdown fences, no commentary
before or after.

STRUCTURE: one <style> block in <head>, one <script> block before </body>.
Vanilla JS and CSS/SVG/Canvas only.

ZERO EXTERNAL DEPENDENCIES: no <script src> or <link> to any external
domain, no web fonts, no external images/audio/video. System font stack
only. Build any visuals with CSS, inline SVG, or Canvas 2D drawing calls.

REQUIRED: at least 2-3 real interactive controls appropriate to the concept
(buttons, sliders, click-to-add-a-point, text inputs, step forward/back) and
a visible readout of current state that updates as the student interacts.
Make it genuinely playable, not a single button that does one thing once -
this is the whole point, favor MORE interactivity over a simpler widget.

Examples of the bar to hit:
- Linear regression: click to add data points on a canvas, a line re-fits
  live, show the equation/error updating.
- A sorting algorithm: array of bars, step/play controls, current
  comparison highlighted, editable input array.
- A Turing machine / state machine: an input field, step button showing
  head position and state transition, a visible tape/state diagram.
- Gradient descent: a slider for learning rate, click to place a starting
  point, step button shows it moving down a loss curve.

HARD SAFETY BANS (do not violate any of these):
- No `while(true)` or any loop without a guaranteed-terminating condition.
- Any `setInterval`/animation loop must have a working Pause/Stop control
  and must actually stop when clicked - never leave a runaway timer.
- Wrap all script logic in try/catch; also set `window.onerror` to show a
  visible small error message in the page instead of a silent blank widget.
- No `fetch`, `XMLHttpRequest`, `WebSocket`, or `import` of any kind.
- Keep it compact - roughly 100-250 lines total. A smaller, fully-working
  widget beats a larger broken one.
"""

_CSP_META = (
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
    "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; "
    "font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; "
    "base-uri 'none'\">"
)

# Reports the widget's real content height to the parent page so the iframe
# can be sized to fit instead of guessing a fixed pixel height (the "so
# small, make it fit" feedback). CSP's connect-src doesn't govern
# postMessage, so this isn't blocked by the CSP above. The iframe's origin
# is opaque under sandbox="allow-scripts" (no allow-same-origin) - postMessage
# has to target '*' since the child can't know a real parent origin, and the
# parent must validate via event.source, not event.origin (which is always
# the literal string "null" for an opaque origin, not "unset"/omittable).
_RESIZE_SCRIPT = """
<script>
new ResizeObserver(() => {
  parent.postMessage({ __widgetResize: true, height: document.documentElement.scrollHeight }, '*');
}).observe(document.documentElement);
</script>
"""


def _inject_csp(html: str) -> str:
    """Defense-in-depth: sandbox doesn't block outbound network calls, a CSP
    with connect-src 'none' does. Inject regardless of whether the model
    remembered to (it wasn't even asked to - this is enforced server-side,
    not trusted to prompt compliance)."""
    if "<head>" in html:
        html = html.replace("<head>", f"<head>{_CSP_META}", 1)
    elif "<html>" in html:
        html = html.replace("<html>", f"<html><head>{_CSP_META}</head>", 1)
    else:
        html = _CSP_META + html  # no <head>/<html> at all - prepend as a last resort

    if "</body>" in html:
        html = html.replace("</body>", f"{_RESIZE_SCRIPT}</body>", 1)
    else:
        html += _RESIZE_SCRIPT
    return html


def generate_widget(label: str, definition: str, force: bool = False) -> tuple[str, bool]:
    """Returns (html, was_cached). Same concept label -> same cached widget
    forever (across restarts, across every lecture), unless force=True (the
    explicit Regenerate button), which always calls the model and
    overwrites the cache with the fresh result."""
    if not force:
        cached = get_cached(CACHE_NAME, label)
        if cached:
            return cached, True

    prompt = f"Concept: {label}\nDefinition: {definition}\n\nBuild the interactive widget now."
    # 18s/model, not 25s: a real successful call took 12.6s in testing, and
    # everything here blocks the whole shared event loop (see main.py) - a
    # tighter per-model timeout bounds the worst case across the fallback
    # chain (was up to 100s across 4 models) without cutting into the
    # margin a genuine slow-but-working call actually needs.
    html = generate_with_fallback(prompt, SYSTEM, timeout=18)
    html = html.strip()
    html = re.sub(r"^```(?:html)?\s*", "", html)
    html = re.sub(r"```\s*$", "", html).strip()
    html = _inject_csp(html)
    set_cached(CACHE_NAME, label, html)
    return html, False
