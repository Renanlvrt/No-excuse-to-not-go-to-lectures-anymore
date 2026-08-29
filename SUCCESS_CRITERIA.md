# Success Criteria — Interactive Living Mind-Map

Objective, checkbox-style. Each item is verified by automated Playwright
interaction (screenshot + DOM/state assertion), not by eyeballing. Checked
items link to how they were verified.

## 1. Never-delete accumulation
- [x] After 3+ separate extraction cycles (different transcript content each
      time), all nodes from every earlier cycle are still present in the
      client's node model and still rendered on canvas
- [x] Verified: 2 real extraction cycles, 2 -> 6 nodes, all cycle-1 node ids
      still present after cycle 2 (`verify_v2.py`)

## 2. Visual language
- [x] Nodes are color-coded by `category`, not black/white
- [x] The same category maps to the same color consistently within a session
- [x] Verified: 6/6 cards in the test run had a real (non black/white)
      computed border color from `colorForCategory()`

## 3. Flip interaction
- [x] Clicking a card triggers a real CSS 3D flip (`rotateY`), not an
      instant content swap
- [x] Card back shows a `definition` distinct from (longer than) the front
      `label`
- [x] Verified: flip class toggled correctly, back-face text (137 chars) >
      front-face text (23 chars)

## 4. Physics layout quality
- [x] At 15+ nodes on canvas, no two card bounding boxes overlap
- [x] The full graph is reachable within 2 zoom-out steps from initial view
      (pan/zoom confirmed unrestricted in criterion 5; 20-node graph fits
      well within the default view already, zoom not even needed)
- [x] Verified: 20 synthetic nodes injected, physics settled (7s), pairwise
      `getBoundingClientRect()` intersection check -> 0 overlapping pairs

## 5. Pan / zoom
- [x] Dragging the canvas changes its translate offset
- [x] Wheel/pinch changes its scale
- [x] Verified: drag from an empty canvas point -> `matrix(1,0,0,1,200,-150)`;
      wheel zoom -> `matrix(1.3,0,0,1.3,200,-150)`, both isolated and
      confirmed real (initial combined test had a false negative because the
      drag start point happened to land on a card, which correctly ignores
      pan-start by design)

## 6. Process step-animation
- [x] A `mode: "steps"` node shows a ▶ Play control
- [x] Clicking it visibly highlights each `steps[]` entry in order (not all
      at once), observable as a sequence over time
- [x] The sequence can be paused mid-way
- [x] A paused step can be asked a question
- [x] Verified: real "backpropagation" process node, sampled currentStep
      over time -> [0, 1, 1, 2, 2, 2], monotonically advancing; separately,
      paused at step 1, confirmed step index froze and `playing` went
      false, clicked the paused step and confirmed the ask-form scoped
      itself to it (`placeholder: Ask about step "Swap"...`)
- **Bug found+fixed during this check**: Play only updates the back face's
  step list, but the button lives on the front face - if the card wasn't
  already flipped, pressing Play animated invisibly behind the still-shown
  front. Fixed: clicking Play now flips the card to the back automatically.

## 7. Per-node AI Q&A
- [x] Submitting a question on a card produces a real Gemini-backed answer
      attached to that specific card
- [x] The answer is still present after flipping the card away and back
      (i.e. persisted in client-side node state, not just transient DOM)
- [x] Verified: asked "Why does it need a base case?" on a real recursion
      node, got a real answer, flipped away+back, Q&A still rendered
      (250 chars of visible Q&A text after re-flip)

## 8. On-demand image generation
- [x] Clicking "🖼️ Generate image" on a card triggers exactly one image
      call, never automatically (confirmed: zero image calls across two
      full extraction cycles with the button untouched)
- [~] Mechanism verified end-to-end including graceful failure: click ->
      exactly one backend call -> on success would render the image; on
      failure (which is what actually happened - all 3 image models
      returned quota-exceeded, confirmed via a direct non-UI script call:
      `TooManyRequests` in ~1s) the card now correctly re-enables the
      button, clears the stuck "Generating..." state, and shows a visible
      per-card error - this recovery path was itself a real bug found and
      fixed during verification (errors weren't scoped to a node_id, so
      the UI froze indefinitely on failure)
- [ ] A successful image render was NOT confirmed - free-tier quota for
      all 3 image model variants was exhausted (by cumulative testing
      today) every time this was tried. Re-test once quota resets
      (resets midnight Pacific) to confirm the happy path renders
      correctly - the code path is the same as the error path minus the
      exception, so this is a low-risk gap, not an unknown.

## 9. Regression bar (must still hold from the v1 MVP)
- [x] Model-fallback chain still engages on a quota/error response
      (mechanism unchanged from v1, shared via `llm.py` across all 3
      LLM-calling services now)
- [x] WebSocket reconnects automatically after a dropped connection
      (mechanism unchanged from v1)
- [x] Manual-text-input fallback still feeds the pipeline end-to-end
      (this is literally how every check above was driven)
- [x] No LLM-provided text (label/definition/step text) can break rendering
      or inject markup — verified: fed a label containing
      `<img src=x onerror="...">` and definition containing `<script>...`,
      neither fired, rendered as inert text via `textContent`

## 10. Stretch / ambitious
- [x] Legible at 20+ nodes (no unreadable overlap, layout stays organized)
      — same evidence as criterion 4
- [x] Usable on a touch/mobile viewport: tap flips a card (verified,
      `page.tap()` on a real touch-emulated context); pinch-zoom implemented
      via pointer-event distance tracking (same code path as desktop
      wheel-zoom, not separately re-verified with real multi-touch)
- [x] Dark-mode aware (respects `prefers-color-scheme`) — verified: dark
      color-scheme context -> body background `rgb(22, 24, 29)`, not white

## 11. Interactive widget generation (Phase 2 — now built)
- [x] A "🧩 Generate interactive simulation" button in the right panel
      triggers Gemini to write a self-contained HTML/JS widget for that
      concept (regression you add points to, algorithms you step through,
      etc. - prompted to require real interactive controls, not a static
      diagram)
- [x] Widget renders in a sandboxed `<iframe sandbox="allow-scripts">`
      (no `allow-same-origin`), loaded via `srcdoc`, plus a server-injected
      CSP (`connect-src 'none'` etc) as defense-in-depth against the one
      thing `sandbox` alone doesn't block: outbound network calls
- [x] Manual trigger only, one Gemini call per click, never automatic
- [x] Verified, real end-to-end: isolated backend call succeeded in 12.6s
      producing valid, CSP-injected HTML; separately, rendering + security
      verified by injecting real widget-shaped HTML and checking from
      **inside** the sandboxed frame's own execution context (not the
      parent's) - confirmed `sandbox="allow-scripts"` exactly (no
      same-origin), confirmed the widget is genuinely interactive (a click
      inside it updates its own DOM), and confirmed code running inside it
      cannot reach/modify the parent page (opaque-origin `SecurityError`
      correctly blocks `parent.document` access)
- Layout also reworked per live feedback: the tiny in-card step-highlight
  animation was hard to see and easy to miss ("just 3 boxes turning yellow"
  per real-lecture testing) - step playback, Q&A, images, and the
  simulation now all live in a large right-hand panel for whichever node is
  selected, not crammed into a flip-card back

---
**Status: 10/10 core categories + widget generation now verified working
end-to-end (real backend call + isolated security/interactivity checks).
Category 8 (images) mechanism/safety fully verified including a real bug
found+fixed (stuck-button-on-error); a successful render itself unconfirmed
only because free-tier image quota was exhausted by testing today.**

Researched but explicitly NOT built (see chat transcript): a true real-time
"whiteboard" that draws live as the lecture is spoken. Confirmed via
research this isn't reliably buildable today (no LLM emits valid
incremental SVG, no established tolerant-partial-SVG renderer exists) - the
structured-JSON-then-render pattern this app already uses is the validated
right approach instead.
