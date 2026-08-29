# UI Visual Spec — exact values

Everything in this document is copied directly out of `frontend/style.css`
and `frontend/index.html` (both included verbatim at
`07_SOURCE_CODE_COMPLETE.md`'s `frontend/` sections). Use those as the literal
source of truth — this document exists so a rebuild in a different stack
(e.g. React/Tailwind instead of plain CSS) has every exact value in one
place without having to reverse-engineer a stylesheet. See
`08_SCREENSHOTS_REFERENCE.pdf` for what this actually looks like rendered.

## Color tokens

Defined as CSS custom properties on `:root`, light mode is the default,
dark mode overrides via `@media (prefers-color-scheme: dark)`
(`color-scheme: light dark` is set so the browser also adapts native
form-control chrome). There is no manual light/dark toggle in the UI —
it's purely `prefers-color-scheme`-driven.

| token | light | dark |
|---|---|---|
| `--bg` | `#f3f4f6` | `#16181d` |
| `--panel` | `#ffffff` | `#23262d` |
| `--text` | `#1a1a1a` | `#eee` |
| `--muted` | `#6b7280` | `#9aa0a6` |
| `--border` | `#e0e0e0` | `#3a3d44` |
| `--accent` | `#2e7d32` | `#4caf50` |
| `--err` | `#c62828` | `#ef5350` |

Additional fixed (non-token, same in both modes) colors used directly:
- Stepper "active" step: `#ffc107` (amber), text `#1a1a1a` on it
- Quiz correct highlight: border `var(--accent)`, background
  `rgba(46,125,50,0.18)`
- Quiz wrong highlight: border `var(--err)`, background
  `rgba(198,40,40,0.18)`
- Stepper active glow: `rgba(255,193,7,0.25)` pulsing to
  `rgba(255,193,7,0.12)`

## Category → card color mapping

Not a token — a JS object in `app.js`, applied per-card as an inline
`--card-color` CSS variable:
```js
const CATEGORY_COLORS = {
  math: "#5b8def", code: "#8a5cf6", process: "#f5a623", theory: "#2fb380",
  warning: "#e5484d", definition: "#6b7280", interactive: "#00acc1",
};
```
Any category not in this list falls back to a deterministic HSL hash so
the same never-before-seen category string always gets the same color
within and across sessions:
```js
function colorForCategory(cat) {
  if (CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
  let hash = 0;
  for (const ch of String(cat || "default")) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash}, 62%, 55%)`;
}
```

## Typography

- Font stack: `-apple-system, "Segoe UI", Roboto, sans-serif` (no web
  fonts, no Google Fonts — deliberately zero external font requests)
- `#topbar h1`: `1.1rem`, e.g. "🎓 Lecture → Living Mind-Map"
- `.panel-title` (right panel concept title): `1.3rem`
- `.panel-analogy`: `1rem`, `italic`, line-height `1.45`
- `.panel-definition`: `0.95rem`, line-height `1.45`
- `.card-label` (card front): `0.92rem`, `font-weight: 700`
- `.wrapup-title`: `1.8rem`

## Layout

- Whole page: `html, body` are `height: 100%`, `overflow: hidden`,
  `display: flex; flex-direction: column` — the app never scrolls at the
  page level, only individual panels/lists scroll internally.
- `#topbar`: NOT `position: fixed` (a documented past bug — see
  `02_CONTEXT.md`). It's `flex-shrink: 0` inside the flex column, sized to
  its own content; `#main` (`flex: 1; min-height: 0`) takes the remaining
  vertical space. This is deliberate: a fixed-height topbar plus a
  hardcoded `top: 90px` on `#main` silently clipped the right panel
  whenever the topbar wrapped taller than 90px on a narrower window.
- `#main`: `display: flex` — `#viewport` (canvas, `flex: 1; min-width: 0`)
  on the left, `#panel` (`width: var(--panel-width)`, `--panel-width: 500px`,
  `flex-shrink: 0`) on the right, divided by a `1px solid var(--border)`
  left border on the panel.
- Responsive breakpoint at `max-width: 900px`: `--panel-width` becomes
  `100%`, `#main` switches to `flex-direction: column` (viewport on top at
  `flex: 1 1 50%`, panel below at `flex: 1 1 50%` with a top border instead
  of a left one).

## Cards (canvas nodes)

- Size: **190px × 110px** desktop; **220px × 130px** under
  `@media (pointer: coarse)` (touch devices get bigger touch targets)
- Absolutely positioned within `#canvas`, centered on their `(x, y)` via
  negative margins (`margin-left: -95px; margin-top: -55px`)
- `border-radius: 10px`, `border: 2px solid var(--card-color, #888)`
  (the category color), `background: var(--panel)`,
  `box-shadow: 0 2px 6px rgba(0,0,0,0.15)`
- New card fade-in: `opacity` transitions `0 → 1` over `0.5s ease` via an
  `.entering` class removed shortly after insertion
- Flip mechanic: `.card-inner` has `perspective: 900px` on the parent
  `.card`, `transform-style: preserve-3d`, `transition: transform 0.5s`;
  `.flipped` applies `rotateY(180deg)`. Each face (`.card-face`) is
  `position: absolute; inset: 0; backface-visibility: hidden;` plus a
  defensive `transform: rotateY(0deg)` no-op on the front face (some
  browser engines ignore `backface-visibility` on an untransformed child of
  a `preserve-3d` parent without this).
- Card front: a colored badge (`.card-badge`, uppercase, `0.62rem`,
  category-colored background, white text) + the label
  (`.card-label`, bold, `0.92rem`) + a `.card-hint` pinned to the bottom
  via `margin-top: auto` inside the flex-column face
- Card back (`.card-back`): scrollable (`overflow-y: auto`), shows
  definition/error/Q&A history — but note per `01_PRD.md` §3.6, the *main*
  interaction surface (simulation, image, video, ask, steps) is the right
  panel, not the card back; the flip is now mostly cosmetic/definition-peek
- Selected state: `.card.selected .card-face` gets
  `box-shadow: 0 0 0 3px var(--accent)`

## Canvas / physics layout

- `#canvas` is centered in `#viewport` (`left: 50%; top: 50%`), panned via
  a CSS `transform: translate() scale()` driven by pointer-drag and
  wheel/pinch handlers (not scroll)
- Physics: `d3-force` simulation, exact forces and parameters:
  ```js
  .force("charge", d3.forceManyBody().strength(-260))
  .force("link", d3.forceLink([]).id((d) => d.id).distance(140))
  .force("center", d3.forceCenter(0, 0).strength(0.06))
  .force("rectCollide", rectCollideForce())
  ```
  `rectCollideForce()` is a **hand-written custom force**, not d3's
  built-in `forceCollide` (which is circle-only and would either overlap
  rectangular cards or force an overly-large circular buffer around them).
  It does pairwise AABB overlap checks between every pair of nodes each
  tick, using the fixed `CARD_W=190, CARD_H=110` as each node's half-extent
  box, and pushes overlapping pairs apart along whichever axis (x or y) has
  the smaller overlap. See `frontend/app.js` for the full ~20-line
  implementation, included verbatim in the source snapshot.
- Edges are drawn in an absolutely-positioned, `pointer-events: none` SVG
  layer (`#edgeLayer`) redrawn every simulation tick: `<line>` (`stroke:
  var(--muted); stroke-width: 2`) with an arrowhead `<marker>` plus a
  small `11px` label at the midpoint.

## Buttons and icon/emoji labels (exact, verbatim — reproduce these exact strings)

Top bar, left to right:
- `▶ Start listening` (button id `startBtn`; while listening, gets class
  `.active` → filled `var(--accent)` background, white text; label text
  itself does not change to a pause icon — the button's active/inactive
  visual state is carried entirely by the `.active` class + background
  color change, not by swapping the emoji)
- `🎁 Wrap up` (id `wrapupBtn`)
- `🔍 Fit to view` (id `fitViewBtn`)
- `📝 Quiz me` (id `quizBtn`)

Right panel, per concept, in this exact order and exact label text:
- `🧩 Generate interactive simulation`
- Once generated: `⛶ Open large`, `↻ Reset`, `🔄 Regenerate`
- `🧠 Test yourself on this` (below the simulation)
- `🎬 Generate teaching video`
- `🖼️ Generate image`
- Ask box: a text `<input>` + an unlabeled submit button (send icon /
  "Ask" text per whatever was last in `app.js` — check the source snapshot
  for the literal current button text if this matters pixel-exactly)

Modals:
- Simulation full-screen overlay close: `✕ Close`
- Quiz overlay close: `✕ Close`
- Wrap-up close: `✕ Close & keep going` (note the exact wording — it's a
  deliberate signal that closing does NOT end anything)

Generic buttons: `font-size: 0.9rem; padding: 0.45rem 0.9rem;
border-radius: 8px; border: 1px solid var(--border); background:
var(--bg); color: var(--text)`; `:hover` → `filter: brightness(1.1)`;
`:disabled` → `opacity: 0.5; cursor: default`.

## Section order inside the right panel (`#panel`) for a selected node

Exactly as listed in `01_PRD.md` §3.6 — category badge → title
(`.panel-title`) → analogy (`.panel-analogy`, styled as an italic
left-accent-bordered callout, `border-left: 3px solid var(--accent)`,
background `var(--bg)`, rounded on the non-border corners) → definition
(`.panel-definition`) → error banner (conditional) → process
walkthrough section (conditional on `mode: "steps"`) → interactive
simulation section → teaching video section → image section →
ask-a-question section. Each section below the definition is wrapped in
`.panel-section` (`margin: 1.1rem 0; padding-top: 1.1rem; border-top: 1px
solid var(--border)`) with an uppercase muted `<h3>` label
(`0.9rem`, `color: var(--muted)`, `text-transform: uppercase`,
`letter-spacing: 0.03em`).

## Animated stepper (process walkthrough)

Numbered circles (`.stepper-circle`, `34px` diameter, `2px solid
var(--border)`, bold `0.85rem` number) connected by horizontal lines
(`.stepper-line`, `3px` tall, `var(--border)`). States:
- `.done`: border+background `var(--accent)`, white text
- `.active`: border+background `#ffc107` (amber), text `#1a1a1a`,
  `transform: scale(1.25)`, glow via `box-shadow: 0 0 0 6px
  rgba(255,193,7,0.25)`, **plus a real looping CSS keyframe animation**
  (not just the scale) — `stepper-pulse`, `1.1s ease-in-out infinite`,
  breathing the glow radius/opacity between `6px @ 0.25 alpha` and
  `11px @ 0.12 alpha`
- Transition easing on every state change: `cubic-bezier(.34,1.56,.64,1)`
  (a slight overshoot/bounce, `0.4s`) — deliberately not a linear/ease-out
  fade, to make each step change visually punchy and readable at a glance
  (this replaced an earlier, harder-to-notice implementation — see
  `02_CONTEXT.md`)

Below the stepper: `.step-detail-box` (`background: var(--bg)`, rounded,
padded, min-height `3.2rem`) shows the current step's label (bold) and
detail text, fading via `opacity` transition `0.25s ease` on step change.

## Modals (simulation full-screen / quiz / wrap-up)

All three share the same base overlay pattern: `position: fixed; inset:
0; z-index: 200; background: rgba(0,0,0,0.75)`, hidden by default
(`display: none`), shown via a `.open` class (`display: flex`), with
`padding: 3vh 3vw` (wrap-up uses `4vh 3vw` and `align-items: flex-start`
instead of `center` since it can be tall). The inner box:
`border-radius: 12-14px`, `background: var(--panel)`, `box-shadow: 0 10px
40px rgba(0,0,0,0.5)`. Simulation overlay's iframe fills available space
(`flex: 1; width: 100%; border: none; background: white` — deliberately
white regardless of dark mode, since generated widget HTML assumes a
light background per its own generation prompt).

Quiz-specific: `.quiz-option` buttons stack vertically
(`display:flex; flex-direction:column; gap:0.5rem`), each left-aligned,
`padding: 0.7rem 0.9rem`, `border-radius: 8px`. On answer: the chosen
option and/or the correct one get `.correct` (accent green tint) or
`.wrong` (err red tint) classes; an explanation box appears below
(`.quiz-explanation`, muted background).

Wrap-up specific: `.wrapup-page` max-width `720px`, generous padding
(`2.2rem 2.4rem 2.6rem`), title `1.8rem`, a muted `.wrapup-subtitle`
(`0.9rem`), bullets as a normal `<ul>` styled at `1.05rem`/`line-height:
1.7` with `0.7rem` gaps, and a `.wrapup-hint` footer separated by a top
border.

## Toast notifications

`#toastContainer`: `position: fixed; top: 1rem`, horizontally centered
(`left: 50%; transform: translateX(-50%)`), `z-index: 500`, stacks
vertically (`flex-direction: column; gap: 0.5rem`), and critically
`pointer-events: none` on the container itself (so toasts never block
clicks on the page underneath) while individual `.toast` elements would
still be clickable if given their own `pointer-events: auto` (not
currently used for interactive toasts — all toasts here are
informational-only).

Each `.toast`: `background: var(--err)` (red) by default, or
`.toast-ok` variant with `background: var(--accent)` (green) for
success/info messages — see `showToast(message, kind, duration)` in
`app.js`, called as `showToast(msg, "err")` or `showToast(msg, "ok")`.
Enter/exit animated via `opacity`/`transform: translateY` transition
(`0.25s ease`), default visible duration **6000ms** (`showToast`'s
`duration` parameter default), white text, `border-radius: 8px`, drop
shadow `0 4px 14px rgba(0,0,0,0.3)`, `max-width: 90vw` (never overflows
small viewports).

## Icon usage note

All icons in this app are plain Unicode emoji embedded directly in
button/heading text — there is no icon font, no SVG icon set, no
Font Awesome/Material Icons/Lucide dependency anywhere. Reproduce icons
by using the literal emoji characters listed above, not by swapping in an
icon library.
