/* Lecture -> living mind-map. See SUCCESS_CRITERIA.md for what each part
 * of this file needs to satisfy.
 *
 * Layout model: cards on the canvas are lightweight (label + tiny flip-back
 * definition). All the real interaction - full definition, step animation,
 * AI Q&A, image, interactive simulation - lives in the right panel for
 * whichever node is currently SELECTED. Selecting a node = clicking its
 * card (which also flips it, for a quick glance either way). */

// ---------- DOM refs ----------
const startBtn = document.getElementById("startBtn");
const wrapupBtn = document.getElementById("wrapupBtn");
const fitViewBtn = document.getElementById("fitViewBtn");
const quizBtn = document.getElementById("quizBtn");
const quizOverlay = document.getElementById("quizOverlay");
const quizContent = document.getElementById("quizContent");
const quizOverlayClose = document.getElementById("quizOverlayClose");
const wrapupOverlay = document.getElementById("wrapupOverlay");
const wrapupContent = document.getElementById("wrapupContent");
const wrapupClose = document.getElementById("wrapupClose");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const manualInput = document.getElementById("manualInput");
const viewport = document.getElementById("viewport");
const canvasEl = document.getElementById("canvas");
const edgeLayer = document.getElementById("edgeLayer");
const placeholderHint = document.getElementById("placeholderHint");
const panelEl = document.getElementById("panel");
const simOverlay = document.getElementById("simOverlay");
const simOverlayBox = document.querySelector(".sim-overlay-box");
const simOverlayTitle = document.getElementById("simOverlayTitle");
const simOverlayClose = document.getElementById("simOverlayClose");

const levelSelect = document.getElementById("levelSelect");
const keyBox = document.getElementById("keyBox");
const keyInput = document.getElementById("keyInput");
const keySaveBtn = document.getElementById("keySaveBtn");

let fullTranscript = "";
let ws;
let listening = false;      // mic/speech-recognition state
let wsConnected = false;    // websocket state - INDEPENDENT of listening now,
// so ask/quiz/simulations/wrap-up etc. keep working after you hit Stop
let reconnectDelay = 1000;
let selectedNodeId = null;
let hasKey = false;          // set by the backend's stt_status message
// Three comprehension levels per concept, all read from text already in
// memory: 1 = analogy (intuition), 2 = definition (mechanism), 3 = the
// generated exam-level text. Switching levels NEVER triggers a request -
// only the Rigour tab's explicit button does, once per concept ever.
let globalLevel = 2;
let partialTranscript = "";  // ElevenLabs interim text, replaced as it firms up
let audioStream = null, audioContext = null, audioNode = null, audioSource = null;

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || "";
}

// ---------- global toast feedback ----------
// The small top status line is easy to miss (especially mid-lecture) and
// several actions used to fail completely silently if the websocket wasn't
// open - direct feedback: "no feedback like what it is" on both the quiz
// button and the ask box. Every user-triggered action now either succeeds
// visibly or shows a toast explaining why not.
const toastContainer = document.getElementById("toastContainer");
function showToast(message, kind = "err", duration = 6000) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function wsReady() {
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  showToast("Not connected right now - reconnecting automatically, try again in a moment.", "err");
  return false;
}

// ---------- category visual language: color + shape + icon accent ----------
const CATEGORY_STYLES = {
  math:        { color: "#5b8def", icon: "Σ", shape: "diamond" },
  code:        { color: "#8a5cf6", icon: "</>", shape: "hexagon" },
  process:     { color: "#f5a623", icon: "→", shape: "hexagon" },
  theory:      { color: "#2fb380", icon: "◎", shape: "rounded" },
  warning:     { color: "#e5484d", icon: "!", shape: "diamond" },
  definition:  { color: "#6b7280", icon: "§", shape: "rounded" },
  interactive: { color: "#00acc1", icon: "⚙", shape: "hexagon" },
};
function styleForCategory(cat) {
  if (CATEGORY_STYLES[cat]) return CATEGORY_STYLES[cat];
  let hash = 0;
  for (const ch of String(cat || "default")) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return { color: `hsl(${hash}, 62%, 55%)`, icon: "●", shape: "rounded" };
}
function colorForCategory(cat) { return styleForCategory(cat).color; }

// ---------- node/graph state ----------
// nodeState[id] doubles as the d3 simulation's node object (x/y/vx/vy live
// directly on it) AND our app metadata (label/definition/qa/image/etc).
const nodeState = {};
window.nodeState = nodeState; // exposed for automated verification (see SUCCESS_CRITERIA.md)
const nodesArr = [];
let linksArr = [];
const cardEls = {};   // id -> card DOM element
const edgeEls = {};   // "from|to" -> {path, labelBg, labelEl, hasLabel}

const isCoarsePointer = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
const BASE_CARD_W = isCoarsePointer ? 220 : 190, BASE_CARD_H = isCoarsePointer ? 130 : 110;

// ============================================================
// Semantic Knowledge Map layout: hierarchy (from the LLM's own
// parent -> child edges) decides WHERE everything goes; d3-force below is
// only a lightweight smoother + spacing/collision pass on top of that, not
// the layout algorithm itself.
// ============================================================

// ---------- 1. hierarchy: depth (ring) + primary parent (wedge nesting) ----
// BFS from every "root" (no incoming edge) simultaneously, so a node's depth
// is its shortest hierarchical distance from any root. Depth 1 = "major
// concepts" ring around the implied lecture center; deeper rings = their
// sub-concepts. Naturally cycle-safe (BFS never revisits a node) and
// degrades gracefully to "everything is a root" before any edges exist yet.
function computeHierarchy(nodes, links) {
  const inDegree = {}, outDegree = {}, adj = {};
  for (const n of nodes) { inDegree[n.id] = 0; outDegree[n.id] = 0; }
  for (const l of links) {
    const from = typeof l.source === "object" ? l.source.id : l.source;
    const to = typeof l.target === "object" ? l.target.id : l.target;
    if (!(from in inDegree) || !(to in inDegree)) continue;
    inDegree[to]++; outDegree[from]++;
    (adj[from] = adj[from] || []).push(to);
  }

  const depth = {}, primaryParentOf = {}, childrenOf = {};
  const roots = nodes.filter((n) => inDegree[n.id] === 0);
  const queue = [];
  for (const r of roots) { depth[r.id] = 1; queue.push(r.id); }
  let qi = 0;
  while (qi < queue.length) {
    const id = queue[qi++];
    for (const childId of adj[id] || []) {
      if (!(childId in depth)) {
        depth[childId] = depth[id] + 1;
        primaryParentOf[childId] = id;
        (childrenOf[id] = childrenOf[id] || []).push(childId);
        queue.push(childId);
      }
    }
  }
  // A node BFS never reached is part of a pure cycle with no entry point
  // (e.g. A->B->A, both have inDegree 1) - vanishingly rare from the LLM's
  // output, but treat it as its own root rather than crash/hang.
  for (const n of nodes) {
    if (!(n.id in depth)) { depth[n.id] = 1; roots.push(n); }
  }

  return { depth, primaryParentOf, childrenOf, inDegree, outDegree, roots };
}

// ---------- 2. importance: degree + depth-tier, mapped through a SQRT
// scale (not linear) since it drives card AREA - matching standard
// dataviz practice for size-encoded quantities. ----------
function computeImportance(nodes, hier) {
  const { inDegree, outDegree, depth } = hier;
  let maxDegree = 1;
  for (const n of nodes) maxDegree = Math.max(maxDegree, inDegree[n.id] + outDegree[n.id]);
  const degreeScale = d3.scaleSqrt().domain([0, maxDegree]).range([0.85, 1.35]).clamp(true);
  for (const n of nodes) {
    const degree = inDegree[n.id] + outDegree[n.id];
    const depthTierBoost = depth[n.id] === 1 ? 1.12 : depth[n.id] === 2 ? 1.0 : 0.92;
    const scale = 0.7 * degreeScale(degree) + 0.3 * depthTierBoost;
    n.importance = scale;
    n.w = Math.round(BASE_CARD_W * scale);
    n.h = Math.round(BASE_CARD_H * scale);
    n.depth = depth[n.id];
  }
}

// ---------- 3. angular layout: each node gets a wedge of the circle
// proportional to its own + its descendants' footprint, subdivided
// recursively (same idea as d3.tree()'s separation, hand-rolled radially).
// Stable id-sort ordering means re-running this every ~20s keeps existing
// nodes' wedges nearly unchanged - a new sibling narrows its neighbors a
// little instead of reshuffling the whole ring. ----------
function computeAngles(hier, sizeOf) {
  const { childrenOf, roots } = hier;
  const angle = {};
  function subtreeWeight(id) {
    let w = sizeOf(id);
    for (const c of childrenOf[id] || []) w += subtreeWeight(c);
    return w;
  }
  function assign(ids, startAngle, endAngle) {
    const weights = ids.map(subtreeWeight);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let a = startAngle;
    ids.forEach((id, i) => {
      const span = (endAngle - startAngle) * (weights[i] / total);
      angle[id] = a + span / 2;
      const kids = (childrenOf[id] || []).slice().sort();
      if (kids.length) assign(kids, a, a + span);
      a += span;
    });
  }
  const rootIds = roots.map((r) => r.id).sort();
  if (rootIds.length) assign(rootIds, 0, Math.PI * 2);
  return angle;
}

// ---------- 4. ring radius per depth: grows to fit however many/large the
// nodes at that depth actually are, instead of a fixed guess. ----------
function computeRingRadii(nodes, hier) {
  const { depth } = hier;
  const maxDepth = nodes.length ? Math.max(...nodes.map((n) => depth[n.id])) : 1;
  const perDepth = {};
  for (const n of nodes) (perDepth[depth[n.id]] = perDepth[depth[n.id]] || []).push(n);
  const radius = { 0: 0 };
  const RING_GAP = 70;
  for (let d = 1; d <= maxDepth; d++) {
    const group = perDepth[d] || [];
    const maxDim = group.length ? Math.max(...group.map((n) => Math.max(n.w, n.h))) : BASE_CARD_H;
    const circumferenceNeeded = group.reduce((sum, n) => sum + n.w + 24, 0);
    const minRadiusForSpacing = circumferenceNeeded / (Math.PI * 2);
    radius[d] = Math.max(radius[d - 1] + maxDim / 2 + RING_GAP, minRadiusForSpacing, radius[d - 1] + 160);
  }
  return radius;
}

// ---------- 5. tie it together: compute every node's target anchor
// (tx, ty). THIS is the layout algorithm - the force simulation below never
// decides structure, only eases nodes toward these anchors and resolves
// local spacing. ----------
function applyHierarchyLayout() {
  const hier = computeHierarchy(nodesArr, linksArr);
  computeImportance(nodesArr, hier);
  const angle = computeAngles(hier, (id) => nodeState[id].w);
  const radius = computeRingRadii(nodesArr, hier);
  for (const n of nodesArr) {
    const r = radius[hier.depth[n.id]] ?? radius[1] ?? 200;
    const a = angle[n.id] ?? 0;
    n.tx = Math.cos(a - Math.PI / 2) * r;
    n.ty = Math.sin(a - Math.PI / 2) * r;
  }
  return hier;
}

// ---------- 6. d3-force: lightweight smoothing + spacing ONLY. Weak charge
// (just enough for organic local jitter, not global structure), forceX/Y
// gently pull each node toward its hierarchy-computed anchor, and
// forceCollide (sized to each card's real, importance-scaled footprint)
// resolves overlap. Low alphaDecay + a mild reheat keeps existing nodes
// drifting into a new layout rather than jumping. ----------
const simulation = d3.forceSimulation([])
  .force("x", d3.forceX((d) => d.tx).strength(0.12))
  .force("y", d3.forceY((d) => d.ty).strength(0.12))
  .force("charge", d3.forceManyBody().strength(-30))
  .force("collide", d3.forceCollide((d) => Math.hypot(d.w, d.h) / 2 + 14).strength(0.9).iterations(3))
  .alphaDecay(0.05)
  .on("tick", onTick);

function onTick() {
  for (const id in cardEls) {
    const n = nodeState[id];
    cardEls[id].style.transform = `translate(${n.x}px, ${n.y}px)`;
  }
  drawEdges();
}

// ---------- edges: curved paths, bowed outward from the shared centroid so
// they sweep around already-placed cards near the hub instead of cutting
// straight through them; labels ride the curve's midpoint on their own
// background pill so they stay legible over any card color. ----------
function drawEdges() {
  for (const key in edgeEls) {
    const { path, labelBg, labelEl, hasLabel } = edgeEls[key];
    const [fromId, toId] = key.split("|");
    const a = nodeState[fromId], b = nodeState[toId];
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const centerDist = Math.hypot(mx, my) || 1;
    const outX = mx / centerDist, outY = my / centerDist;
    const bow = 22 + Math.min(60, Math.hypot(b.x - a.x, b.y - a.y) * 0.12);
    const cx = mx + outX * bow, cy = my + outY * bow;
    path.setAttribute("d", `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`);

    if (hasLabel) {
      labelEl.setAttribute("x", cx);
      labelEl.setAttribute("y", cy);
      try {
        const bbox = labelEl.getBBox();
        labelBg.setAttribute("x", bbox.x - 4);
        labelBg.setAttribute("y", bbox.y - 2);
        labelBg.setAttribute("width", bbox.width + 8);
        labelBg.setAttribute("height", bbox.height + 4);
      } catch (e) { /* getBBox can throw before first paint in some engines - skip a frame */ }
    }
  }
}

// ---------- graph merge (never delete; hierarchy recomputed every update,
// existing nodes drift gently rather than jump - see applyHierarchyLayout
// and the gentle alpha reheat below). ----------
function mergeGraph(data) {
  let addedAny = false;
  const newlyAdded = [];
  for (const n of data.nodes || []) {
    if (nodeState[n.id]) {
      // whitelist: anything generated client-side (deep text, image, qa...)
      // must NOT be listed here or an extraction cycle would wipe it.
      Object.assign(nodeState[n.id], {
        label: n.label, definition: n.definition, analogy: n.analogy, category: n.category,
        mode: n.mode, steps: n.steps || [],
      });
    } else {
      const node = Object.assign(
        {
          x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0,
          w: BASE_CARD_W, h: BASE_CARD_H, importance: 1, depth: 1,
          qa: [], image: null, widgetHtml: null,
          isNew: true, playing: false, currentStep: -1, pausedAtStep: null,
          lastError: null,
          // Persisted (not just local DOM state) so a pending request
          // survives navigating to another node and back - previously this
          // only lived on the button element itself, so clicking away made
          // an in-flight generation look "lost" and let a second click
          // double-fire a duplicate request for the same node.
          widgetPending: false, imagePending: false, askPending: false,
          videoPending: false, videoUrl: null,
          deep: null, deepPending: false, level: null, // level: per-node override of globalLevel
          audioUrls: {}, audioPending: false, // per-level TTS, keyed 1/2/3
          checkPending: false, checkQuestion: null, checkAnswered: false,
        },
        n, { steps: n.steps || [] }
      );
      nodeState[n.id] = node;
      nodesArr.push(node);
      newlyAdded.push(node);
      addedAny = true;
    }
  }

  linksArr = (data.edges || [])
    .filter((e) => nodeState[e.from] && nodeState[e.to])
    .map((e) => ({ source: e.from, target: e.to, label: e.label }));

  // Layout: recompute hierarchy/importance/anchors for the whole graph.
  // Stable id-sorted angle assignment means existing nodes' anchors shift
  // only a little (a new sibling narrows their wedge) - not a full reshuffle.
  const hier = applyHierarchyLayout();

  // Brand-new nodes start AT their primary parent's current on-screen
  // position (or their own target anchor if root-level) so they visually
  // grow outward from what's already there instead of popping in randomly.
  for (const node of newlyAdded) {
    const parent = nodeState[hier.primaryParentOf[node.id]];
    node.x = parent ? parent.x : node.tx;
    node.y = parent ? parent.y : node.ty;
  }

  simulation.nodes(nodesArr);
  // Gentle reheat only: the graph should drift into its new layout, not
  // jump - a hard restart every ~20s would fight "preserve existing
  // positions where practical."
  simulation.alpha(Math.max(simulation.alpha(), addedAny ? 0.35 : 0.15)).restart();

  renderAllCards();
  renderEdgeElements(hier);
  if (nodesArr.length) placeholderHint.style.display = "none";
}

// A link is a "tree" edge if it's how its target actually got placed in the
// hierarchy (its primary parent); anything else - a second parent, a
// same-rank cross-reference - is a "crosslink": still drawn, but visually
// subordinate (thinner/dashed) so the primary structure stays legible.
function edgeKind(hier, fromId, toId) {
  return hier.primaryParentOf[toId] === fromId ? "tree" : "crosslink";
}

function renderEdgeElements(hier) {
  for (const e of linksArr) {
    const fromId = typeof e.source === "object" ? e.source.id : e.source;
    const toId = typeof e.target === "object" ? e.target.id : e.target;
    const key = `${fromId}|${toId}`;
    if (!edgeEls[key]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const labelBg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      const labelEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      labelBg.setAttribute("class", "edge-label-bg");
      labelEl.setAttribute("class", "edge-label-text");
      labelEl.setAttribute("text-anchor", "middle");
      labelEl.textContent = e.label || "";
      const hasLabel = !!e.label;
      edgeLayer.appendChild(path);
      if (hasLabel) { edgeLayer.appendChild(labelBg); edgeLayer.appendChild(labelEl); }
      edgeEls[key] = { path, labelBg, labelEl, hasLabel };
    }
    const kind = edgeKind(hier, fromId, toId);
    edgeEls[key].path.setAttribute("class", `edge-path edge-${kind}`);
    edgeEls[key].path.setAttribute("marker-end", kind === "tree" ? "url(#arrowhead)" : "url(#arrowhead-faint)");
  }
}

// ---------- card rendering: size/weight reflect computed importance
// (bigger, bolder cards for hub/foundational concepts); category maps to a
// color + icon + accent shape, not just a border color. ----------
function applyCardSizing(card, node) {
  card.style.setProperty("--w", node.w + "px");
  card.style.setProperty("--h", node.h + "px");
  card.style.setProperty("--scale", node.importance || 1);
  card.classList.toggle("important", (node.importance || 1) >= 1.15);
}

function renderAllCards() {
  for (const id in nodeState) {
    const node = nodeState[id];
    if (!cardEls[id]) createCard(node);
    else applyCardSizing(cardEls[id], node);
  }
  refreshCardBacks();
}

// A card's back face shows the current level's text. Level 3 falls back to
// the definition for any node whose deep text hasn't been generated - the
// global switch is a pure in-memory re-render, it never fetches anything.
function levelText(node, level) {
  if (level === 1) return node.analogy || node.definition || node.label;
  if (level === 3) return node.deep || node.definition || node.label;
  return node.definition || node.label;
}

function refreshCardBacks() {
  for (const id in cardEls) {
    const node = nodeState[id];
    const def = cardEls[id].querySelector(".card-definition");
    if (node && def) def.textContent = levelText(node, globalLevel);
  }
}

function createCard(node) {
  const card = document.createElement("div");
  const catStyle = styleForCategory(node.category);
  card.className = `card entering shape-${catStyle.shape}`;
  card.dataset.nodeId = node.id;
  applyCardSizing(card, node);

  const inner = document.createElement("div");
  inner.className = "card-inner";

  const front = document.createElement("div");
  front.className = "card-face card-front";
  front.style.setProperty("--card-color", catStyle.color);
  const badge = document.createElement("div");
  badge.className = "card-badge";
  const badgeIcon = document.createElement("span");
  badgeIcon.className = "card-badge-icon";
  badgeIcon.textContent = catStyle.icon;
  badge.appendChild(badgeIcon);
  badge.appendChild(document.createTextNode(node.category || "concept"));
  const label = document.createElement("div");
  label.className = "card-label";
  label.textContent = node.label; // textContent only - never innerHTML with LLM text
  front.appendChild(badge);
  front.appendChild(label);
  if ((node.mode === "steps" || node.mode === "interactive") && node.steps && node.steps.length) {
    const hint = document.createElement("div");
    hint.className = "card-hint";
    hint.textContent = "⚡ has a simulation - click to explore";
    front.appendChild(hint);
  }

  const back = document.createElement("div");
  back.className = "card-face card-back";
  back.style.setProperty("--card-color", catStyle.color);
  const def = document.createElement("div");
  def.className = "card-definition";
  def.textContent = levelText(node, globalLevel);
  back.appendChild(def);

  inner.appendChild(front);
  inner.appendChild(back);
  card.appendChild(inner);

  inner.addEventListener("click", () => {
    inner.classList.toggle("flipped");
    selectNode(node.id);
  });

  canvasEl.appendChild(card);
  cardEls[node.id] = card;
  requestAnimationFrame(() => card.classList.remove("entering"));
}

// ---------- right panel: the real interaction surface for one selected node ----------
function selectNode(nodeId) {
  selectedNodeId = nodeId;
  // the server needs to know which card a spoken "explain that simpler"
  // refers to.
  if (wsReady()) ws.send(JSON.stringify({ type: "select_node", node_id: nodeId }));
  for (const id in cardEls) cardEls[id].classList.toggle("selected", id === nodeId);
  renderPanel();
}

function renderPanel() {
  panelEl.textContent = "";
  const node = nodeState[selectedNodeId];
  if (!node) {
    const hint = document.createElement("div");
    hint.className = "panel-hint";
    hint.textContent = "Click a concept on the map to explore it here.";
    panelEl.appendChild(hint);
    return;
  }

  const catStyle = styleForCategory(node.category);
  const badge = document.createElement("div");
  badge.className = "card-badge";
  badge.style.setProperty("--card-color", catStyle.color);
  badge.textContent = `${catStyle.icon} ${node.category || "concept"}`;
  panelEl.appendChild(badge);

  const title = document.createElement("h2");
  title.className = "panel-title";
  title.textContent = node.label;
  panelEl.appendChild(title);

  renderLevelSection(node);

  if (node.lastError) {
    const err = document.createElement("div");
    err.className = "card-error";
    err.textContent = "⚠ " + node.lastError;
    panelEl.appendChild(err);
  }

  if (node.steps && node.steps.length) renderStepPlayer(node);
  renderSimulationSection(node);
  renderVideoSection(node);
  renderImageSection(node);
  renderQaSection(node);
}

// ---------- three comprehension levels ----------
// L1 and L2 are text the node already carries (analogy / definition), so
// switching between them is free. L3 is generated once per concept, on an
// explicit click, and cached server-side forever after.
const LEVELS = [
  { n: 1, name: "Intuition", hint: "What is this like?" },
  { n: 2, name: "Mechanism", hint: "How does it actually work?" },
  { n: 3, name: "Rigour", hint: "What would a professor grill you on?" },
];

function renderLevelSection(node) {
  const level = node.level || globalLevel;

  const tabs = document.createElement("div");
  tabs.className = "level-tabs";
  for (const l of LEVELS) {
    const tab = document.createElement("button");
    tab.className = "level-tab" + (l.n === level ? " active" : "");
    tab.textContent = l.name;
    tab.title = l.hint;
    tab.addEventListener("click", () => {
      node.level = l.n; // remembered per node, so coming back keeps this level
      renderPanel();
    });
    tabs.appendChild(tab);
  }
  panelEl.appendChild(tabs);

  const body = document.createElement("p");
  body.className = "panel-definition";
  panelEl.appendChild(body);

  renderSpeakButton(node, level);

  if (level === 1) {
    body.textContent = node.analogy || "No analogy for this concept — try Mechanism.";
    return;
  }
  if (level === 2) {
    body.textContent = node.definition || "";
    return;
  }

  if (node.deep) {
    body.textContent = node.deep;
    return;
  }
  body.textContent = node.definition || "";
  const btn = document.createElement("button");
  if (node.deepPending) {
    btn.textContent = "Generating…";
    btn.disabled = true;
  } else {
    btn.textContent = "🎓 Go deeper";
    btn.addEventListener("click", () => requestDeep(node));
  }
  panelEl.appendChild(btn);
}

// One voice per level (warm/slow, neutral, fast/dense) so the sound says
// which level you're on. Synthesis is cached per (concept, level) on the
// server, so replaying costs zero characters of the TTS quota.
function renderSpeakButton(node, level) {
  const url = (node.audioUrls || {})[level];
  if (url) {
    const audio = document.createElement("audio");
    audio.src = url;
    audio.controls = true;
    audio.autoplay = node.audioAutoplay === level; // only the freshly returned one
    node.audioAutoplay = null;
    audio.className = "level-audio";
    panelEl.appendChild(audio);
    return;
  }
  const btn = document.createElement("button");
  btn.className = "speak-btn";
  if (node.audioPending) {
    btn.textContent = "Voicing…";
    btn.disabled = true;
  } else {
    btn.textContent = "🔊 Read it to me";
    btn.addEventListener("click", () => requestSpeak(node, level));
  }
  panelEl.appendChild(btn);
}

function requestSpeak(node, level) {
  if (node.audioPending) return;
  if (!wsReady()) return;
  node.lastError = null;
  node.audioPending = true;
  ws.send(JSON.stringify({ type: "speak_level", node_id: node.id, level }));
  if (selectedNodeId === node.id) renderPanel();
}

function requestDeep(node) {
  if (node.deepPending) return;
  if (!wsReady()) return;
  node.lastError = null;
  node.deepPending = true;
  ws.send(JSON.stringify({ type: "explain_deep", node_id: node.id }));
  if (selectedNodeId === node.id) renderPanel();
}

// ---------- teaching video (ElevenLabs - needs a Pro-tier key; wired and
// ready, but the actual generation call is confirmed blocked on a free-tier
// key: a live test returned 402 "requires a Pro plan or above". Shows a
// clear, specific message for that case rather than a generic error. ----------
function renderVideoSection(node) {
  const wrap = document.createElement("div");
  wrap.className = "panel-section";
  const heading = document.createElement("h3");
  heading.textContent = "Teaching video";
  wrap.appendChild(heading);

  if (node.videoUrl) {
    const video = document.createElement("video");
    video.src = node.videoUrl;
    video.controls = true;
    video.style.width = "100%";
    video.style.borderRadius = "8px";
    wrap.appendChild(video);

    const regenBtn = document.createElement("button");
    if (node.videoPending) {
      regenBtn.textContent = "Generating...";
      regenBtn.disabled = true;
    } else {
      regenBtn.textContent = "🔄 Regenerate";
      regenBtn.addEventListener("click", () => requestVideo(node, true));
    }
    wrap.appendChild(regenBtn);
  } else {
    const btn = document.createElement("button");
    if (node.videoPending) {
      btn.textContent = "Generating video (can take a few minutes)...";
      btn.disabled = true;
    } else {
      btn.textContent = "🎬 Generate teaching video";
      btn.addEventListener("click", () => requestVideo(node, false));
    }
    wrap.appendChild(btn);
  }
  panelEl.appendChild(wrap);
}

function requestVideo(node, force) {
  if (node.videoPending) return;
  if (!wsReady()) return;
  node.lastError = null;
  node.videoPending = true;
  ws.send(JSON.stringify({ type: "generate_video", node_id: node.id, force }));
  if (selectedNodeId === node.id) renderPanel();
}

// ---------- step player: a real animated stepper (circles + connecting
// line, active one pulses and scales up, completed ones fill solid) - not
// a plain highlighted list row, per direct feedback that the old version
// "isn't animation." Below it, the current step's detail shown large. ----------
function renderStepPlayer(node) {
  const wrap = document.createElement("div");
  wrap.className = "panel-section step-player";

  const heading = document.createElement("h3");
  heading.textContent = "Process walkthrough";
  wrap.appendChild(heading);

  const controls = document.createElement("div");
  controls.className = "step-controls";
  const playBtn = document.createElement("button");
  playBtn.textContent = node.playing ? "⏸ Pause" : (node.currentStep >= 0 ? "▶ Resume" : "▶ Animate");
  playBtn.addEventListener("click", () => {
    if (node.playing) pauseSteps(node.id); else playSteps(node.id);
  });
  controls.appendChild(playBtn);
  if (node.currentStep !== -1 || node.pausedAtStep != null) {
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "↻ Reset";
    resetBtn.addEventListener("click", () => resetSteps(node.id));
    controls.appendChild(resetBtn);
  }
  wrap.appendChild(controls);

  const stepper = document.createElement("div");
  stepper.className = "stepper";
  node.steps.forEach((step, i) => {
    const isDone = node.currentStep > i || (!node.playing && node.pausedAtStep != null && i < node.pausedAtStep);
    const isActive = i === node.currentStep;

    const nodeWrap = document.createElement("div");
    nodeWrap.className = "stepper-node";
    const circle = document.createElement("div");
    circle.className = "stepper-circle" + (isDone ? " done" : "") + (isActive ? " active" : "");
    circle.textContent = isDone ? "✓" : String(i + 1);
    nodeWrap.appendChild(circle);
    stepper.appendChild(nodeWrap);

    if (i < node.steps.length - 1) {
      const line = document.createElement("div");
      line.className = "stepper-line" + (isDone ? " done" : "");
      stepper.appendChild(line);
    }
  });
  wrap.appendChild(stepper);

  const detailBox = document.createElement("div");
  detailBox.className = "step-detail-box";
  const shownIndex = node.currentStep >= 0 ? node.currentStep : (node.pausedAtStep ?? 0);
  const shownStep = node.steps[shownIndex];
  if (shownStep) {
    const strong = document.createElement("strong");
    strong.textContent = `Step ${shownIndex + 1}: ${shownStep.label}`;
    const span = document.createElement("span");
    span.textContent = shownStep.detail || "";
    detailBox.appendChild(strong);
    detailBox.appendChild(span);
  } else {
    detailBox.textContent = "Click Animate to walk through each step.";
  }
  if (!node.playing) {
    detailBox.title = "Ask about this step";
    detailBox.style.cursor = "pointer";
    detailBox.addEventListener("click", () => {
      const input = panelEl.querySelector(".ask-form input");
      if (input && shownStep) { input.placeholder = `Ask about step "${shownStep.label}"...`; input.focus(); }
    });
  }
  wrap.appendChild(detailBox);

  panelEl.appendChild(wrap);
}

function playSteps(nodeId) {
  const node = nodeState[nodeId];
  if (!node || node.playing || !node.steps.length) return;
  node.playing = true;
  node.pausedAtStep = null;
  node.currentStep = -1;
  let i = 0;
  const advance = () => {
    if (!node.playing || i >= node.steps.length) {
      node.playing = false;
      if (selectedNodeId === nodeId) renderPanel();
      return;
    }
    node.currentStep = i;
    if (selectedNodeId === nodeId) renderPanel();
    i++;
    node.playTimeoutId = setTimeout(advance, 1400);
  };
  advance();
}

function pauseSteps(nodeId) {
  const node = nodeState[nodeId];
  if (!node) return;
  node.playing = false;
  clearTimeout(node.playTimeoutId);
  node.pausedAtStep = node.currentStep;
  if (selectedNodeId === nodeId) renderPanel();
}

function resetSteps(nodeId) {
  const node = nodeState[nodeId];
  if (!node) return;
  node.playing = false;
  clearTimeout(node.playTimeoutId);
  node.currentStep = -1;
  node.pausedAtStep = null;
  if (selectedNodeId === nodeId) renderPanel();
}

// ---------- interactive simulation (Gemini-generated, sandboxed iframe) ----------
function renderSimulationSection(node) {
  const wrap = document.createElement("div");
  wrap.className = "panel-section";
  const heading = document.createElement("h3");
  heading.textContent = "Interactive simulation";
  wrap.appendChild(heading);

  if (node.widgetHtml) {
    const controls = document.createElement("div");
    controls.className = "sim-controls";

    const expandBtn = document.createElement("button");
    expandBtn.textContent = "⛶ Open large";
    expandBtn.addEventListener("click", () => openSimFullscreen(node));
    controls.appendChild(expandBtn);

    const resetBtn = document.createElement("button");
    resetBtn.textContent = "↻ Reset";
    resetBtn.title = "Reload the simulation to its starting state (no API call)";
    resetBtn.addEventListener("click", () => {
      const iframe = wrap.querySelector(".sim-frame");
      if (iframe) reloadIframe(iframe, node.widgetHtml);
    });
    controls.appendChild(resetBtn);

    const regenBtn = document.createElement("button");
    regenBtn.title = "Ask Gemini to write a fresh version of this simulation";
    if (node.widgetPending) {
      regenBtn.textContent = "Generating...";
      regenBtn.disabled = true;
    } else {
      regenBtn.textContent = "🔄 Regenerate";
      regenBtn.addEventListener("click", () => requestWidget(node, regenBtn, true));
    }
    controls.appendChild(regenBtn);

    wrap.appendChild(controls);

    const iframe = document.createElement("iframe");
    iframe.className = "sim-frame";
    // Security: allow-scripts WITHOUT allow-same-origin gives the widget an
    // opaque origin - can't read our cookies/localStorage/DOM, can't
    // navigate us, can't open popups/forms. srcdoc (not a data: URL) avoids
    // manual-escaping bugs. The generated HTML also carries a CSP
    // (connect-src 'none' etc, injected server-side) as defense-in-depth
    // against the one thing sandbox doesn't block: outbound network calls.
    iframe.sandbox = "allow-scripts";
    iframe.referrerPolicy = "no-referrer";
    wrap.appendChild(iframe);
    iframe.srcdoc = node.widgetHtml;

    // Active recall tied to the simulation they just played with - ties
    // two flagship features together instead of sitting next to each other.
    const checkWrap = document.createElement("div");
    checkWrap.className = "check-question-wrap";
    if (node.checkQuestion) {
      checkWrap.appendChild(buildQuestionElement(node.checkQuestion, () => {}));
    } else {
      const checkBtn = document.createElement("button");
      if (node.checkPending) {
        checkBtn.textContent = "Generating question...";
        checkBtn.disabled = true;
      } else {
        checkBtn.textContent = "🧠 Test yourself on this";
        checkBtn.addEventListener("click", () => {
          if (node.checkPending) return;
          if (!wsReady()) return;
          node.lastError = null;
          node.checkPending = true;
          ws.send(JSON.stringify({ type: "generate_check", node_id: node.id }));
          if (selectedNodeId === node.id) renderPanel();
        });
      }
      checkWrap.appendChild(checkBtn);
    }
    wrap.appendChild(checkWrap);
  } else {
    const btn = document.createElement("button");
    if (node.widgetPending) {
      btn.textContent = "Generating (can take ~15-25s)...";
      btn.disabled = true;
    } else {
      btn.textContent = "🧩 Generate interactive simulation";
      btn.addEventListener("click", () => requestWidget(node, btn));
    }
    wrap.appendChild(btn);
  }
  panelEl.appendChild(wrap);
}

function reloadIframe(iframe, html) {
  // Force a full reload of the same content to reset the widget's internal
  // JS state - reassigning srcdoc to the same string doesn't reliably
  // reload in every engine, so clear it first.
  iframe.srcdoc = "";
  requestAnimationFrame(() => { iframe.srcdoc = html; });
}

function openSimFullscreen(node) {
  simOverlayTitle.textContent = node.label;
  const existing = simOverlayBox.querySelector("iframe");
  if (existing) existing.remove();
  const existingControls = simOverlayBox.querySelector(".sim-controls");
  if (existingControls) existingControls.remove();

  const controls = document.createElement("div");
  controls.className = "sim-controls";
  controls.style.margin = "0.6rem 1rem 0";
  const resetBtn = document.createElement("button");
  resetBtn.textContent = "↻ Reset";
  controls.appendChild(resetBtn);
  simOverlayBox.querySelector(".sim-overlay-header").after(controls);

  const iframe = document.createElement("iframe");
  iframe.sandbox = "allow-scripts";
  iframe.referrerPolicy = "no-referrer";
  simOverlayBox.appendChild(iframe);
  iframe.srcdoc = node.widgetHtml;
  resetBtn.addEventListener("click", () => reloadIframe(iframe, node.widgetHtml));

  simOverlay.classList.add("open");
}

// Widgets self-report their real content height (see widgetgen.py's
// injected ResizeObserver script) so the iframe can fit its actual content
// instead of a fixed guessed height. The iframe's origin is opaque
// (sandbox="allow-scripts", no allow-same-origin), so event.origin is
// always the literal string "null" - validate via event.source instead.
window.addEventListener("message", (e) => {
  if (!e.data || !e.data.__widgetResize) return;
  const allFrames = [...document.querySelectorAll("#panel .sim-frame, #simOverlay iframe")];
  const frame = allFrames.find((f) => f.contentWindow === e.source);
  if (!frame) return;
  const height = Math.min(Math.max(e.data.height, 200), frame.closest("#simOverlay") ? 4000 : 900);
  frame.style.height = height + "px";
});

simOverlayClose.addEventListener("click", () => simOverlay.classList.remove("open"));
simOverlay.addEventListener("click", (e) => { if (e.target === simOverlay) simOverlay.classList.remove("open"); });

function requestWidget(node, btn, force = false) {
  if (node.widgetPending) return;
  if (!wsReady()) return;
  node.lastError = null;
  node.widgetPending = true;
  ws.send(JSON.stringify({ type: "generate_widget", node_id: node.id, force }));
  if (selectedNodeId === node.id) renderPanel(); // reflect the pending state immediately, not just the clicked button
}

// ---------- image ----------
function renderImageSection(node) {
  const wrap = document.createElement("div");
  wrap.className = "panel-section image-slot";
  if (node.image) {
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${node.image}`;
    img.alt = node.label;
    wrap.appendChild(img);
  } else {
    const btn = document.createElement("button");
    if (node.imagePending) {
      btn.textContent = "Generating…";
      btn.disabled = true;
    } else {
      btn.textContent = "🖼️ Generate image";
      btn.addEventListener("click", () => {
        if (node.imagePending) return;
        if (!wsReady()) return;
        node.lastError = null;
        node.imagePending = true;
        ws.send(JSON.stringify({ type: "generate_image", node_id: node.id }));
        if (selectedNodeId === node.id) renderPanel();
      });
    }
    wrap.appendChild(btn);
  }
  panelEl.appendChild(wrap);
}

// ---------- Q&A ----------
function renderQaSection(node) {
  const wrap = document.createElement("div");
  wrap.className = "panel-section";
  const heading = document.createElement("h3");
  heading.textContent = "Ask about this";
  wrap.appendChild(heading);

  if (node.qa.length) {
    const qaWrap = document.createElement("div");
    qaWrap.className = "qa-list";
    for (const pair of node.qa) {
      const item = document.createElement("div");
      item.className = "qa-item";
      const q = document.createElement("div");
      q.className = "qa-q";
      q.textContent = "Q: " + pair.question;
      const a = document.createElement("div");
      a.className = "qa-a";
      a.textContent = pair.answer;
      item.appendChild(q); item.appendChild(a);
      qaWrap.appendChild(item);
    }
    wrap.appendChild(qaWrap);
  }

  const form = document.createElement("div");
  form.className = "ask-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = node.askPending ? "Waiting for an answer..." : "Ask about this...";
  const askBtn = document.createElement("button");
  askBtn.textContent = node.askPending ? "…" : "Ask";
  if (node.askPending) { input.disabled = true; askBtn.disabled = true; }
  const submit = () => {
    const q = input.value.trim();
    if (!q || node.askPending) return;
    if (!wsReady()) return;
    node.lastError = null;
    node.askPending = true;
    ws.send(JSON.stringify({ type: "ask", node_id: node.id, question: q }));
    if (selectedNodeId === node.id) renderPanel();
  };
  askBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  form.appendChild(input); form.appendChild(askBtn);
  wrap.appendChild(form);
  panelEl.appendChild(wrap);
}

// ---------- WebSocket: connects once on page load, independent of the mic.
// Previously "Stop" closed the socket entirely, which silently broke every
// panel action (ask/quiz/simulations/wrap-up) with zero feedback - exactly
// the bug reported. Now Start/Stop only controls the microphone; the
// connection stays up (and auto-reconnects on any drop) so you can keep
// asking questions, generating simulations, and building the wrap-up
// summary whether or not you're actively "listening." ----------
connect();

startBtn.onclick = () => {
  if (listening) {
    listening = false;
    startBtn.textContent = "▶ Start listening";
    startBtn.classList.remove("active");
    stopElevenLabsCapture();
    setStatus(wsConnected ? "stopped listening (still connected)" : "stopped", "ok");
    return;
  }
  // Transcription is always ElevenLabs Scribe - the browser's own engine is
  // never used, so the transcript is identical on every laptop. All a
  // key-less machine needs is a key pasted into the box above.
  if (!hasKey) {
    keyBox.hidden = false;
    keyInput.focus();
    showToast("Paste an ElevenLabs API key above to start transcribing.", "err");
    return;
  }
  listening = true;
  startBtn.textContent = "■ Stop";
  startBtn.classList.add("active");
  startElevenLabsCapture();
};

// A friend's laptop has no .env, so the key can also be pasted here: it stays
// in this browser's localStorage and is handed to our own backend (which is
// what talks to ElevenLabs), never to a third party.
const KEY_STORAGE = "elevenlabs_api_key";

function sendStoredKey() {
  const key = localStorage.getItem(KEY_STORAGE) || "";
  if (key && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "elevenlabs_key", key }));
  }
}

keySaveBtn.onclick = () => {
  const key = keyInput.value.trim();
  if (!key) return;
  localStorage.setItem(KEY_STORAGE, key);
  if (!wsReady()) return;
  ws.send(JSON.stringify({ type: "elevenlabs_key", key }));
  showToast("Key saved in this browser - press Start listening.", "ok", 4000);
};
keyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") keySaveBtn.click(); });

// Purely a re-render of text already in memory: flipping the whole map to
// another level costs exactly zero API calls, however many nodes there are.
levelSelect.addEventListener("change", () => {
  globalLevel = Number(levelSelect.value);
  for (const id in nodeState) nodeState[id].level = null; // global choice wins over per-node ones
  refreshCardBacks();
  renderPanel();
});

manualInput.addEventListener("input", () => {
  if (!wsReady()) return;
  sendManualText();
});

// The typed text box is sent under its own message type: with ElevenLabs the
// server owns the speech transcript, so a plain `{text}` update (which
// replaces it wholesale) would erase everything transcribed so far.
function sendManualText(force = false) {
  if (!wsReady()) return;
  ws.send(JSON.stringify({ type: "manual_text", text: manualInput.value, force }));
}

function renderTranscript() {
  transcriptEl.textContent = (fullTranscript + (partialTranscript ? " " + partialTranscript : "")).trim();
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function connect() {
  setStatus("connecting...");
  ws = new WebSocket(`ws://${location.host}/ws/lecture`);

  ws.onopen = () => {
    wsConnected = true;
    setStatus(listening ? "listening 🎙️" : "connected", "ok");
    reconnectDelay = 1000;
    sendStoredKey();
    if (manualInput.value.trim() || fullTranscript.trim()) sendManualText();
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "stt_status") {
      hasKey = !!msg.has_key;
      keyBox.hidden = hasKey;
      if (hasKey) keyInput.value = "";
    } else if (msg.type === "partial_transcript") {
      partialTranscript = msg.text || "";
      renderTranscript();
    } else if (msg.type === "transcript") {
      // server-side (ElevenLabs) transcript is authoritative - it already
      // holds every committed segment, so mirror it rather than appending.
      fullTranscript = msg.text || "";
      partialTranscript = "";
      renderTranscript();
    } else if (msg.type === "diagram") {
      mergeGraph(msg.data);
      if (listening) setStatus("listening 🎙️", "ok");
    } else if (msg.type === "empty") {
      if (listening) setStatus("listening 🎙️ (nothing new yet)", "ok");
    } else if (msg.type === "error") {
      setStatus(`backend error: ${msg.message}`, "err");
      const messages = {
        generate_image: "Image generation failed (model may be over quota) - try again later.",
        generate_widget: "Simulation generation failed - try again, or try a different concept.",
        generate_video: msg.needs_pro
          ? "Needs an ElevenLabs Pro plan - this key is free-tier only, so video generation is blocked (confirmed: 402 from their API)."
          : "Video generation failed - try again later.",
        ask: "That didn't go through - try asking again.",
        generate_check: "Couldn't generate a check question - try again.",
        explain_deep: "Couldn't generate the rigorous version - try again.",
        speak_level: "Couldn't read that out loud - try again.",
        generate_quiz: "Couldn't generate the quiz - try again.",
        generate_summary: "Couldn't generate the wrap-up summary - try again.",
        transcribe: "ElevenLabs transcription dropped - press Stop then Start to reconnect, or use the text box below.",
        no_key: "No ElevenLabs API key on this machine - paste one in the box at the top.",
      };
      const friendly = messages[msg.context] || `Gemini isn't accessible right now: ${msg.message}`;
      showToast(friendly, "err");

      // scoped failures (a specific card's ask/image/widget request) must
      // reset that node's panel UI, not just show a global status message -
      // otherwise the button is left stuck disabled forever with no recovery.
      if (msg.node_id && nodeState[msg.node_id]) {
        const node = nodeState[msg.node_id];
        node.lastError = friendly;
        // clear the matching pending flag - without this a failed request
        // left the node stuck "pending" forever (no error shown, no retry
        // possible) even though we now show an error banner.
        if (msg.context === "generate_widget") node.widgetPending = false;
        if (msg.context === "generate_image") node.imagePending = false;
        if (msg.context === "generate_video") node.videoPending = false;
        if (msg.context === "ask") node.askPending = false;
        if (msg.context === "generate_check") node.checkPending = false;
        if (msg.context === "explain_deep") node.deepPending = false;
        if (msg.context === "speak_level") node.audioPending = false;
        if (selectedNodeId === msg.node_id) renderPanel();
      }

      // whole-lecture actions (quiz/wrap-up) have their own modal open with
      // a "Generating..." message that would otherwise sit frozen forever
      // with no visible explanation - update it directly, not just a toast.
      if (msg.context === "generate_quiz" && quizOverlay.classList.contains("open")) {
        quizContent.textContent = "";
        const err = document.createElement("div");
        err.className = "quiz-progress";
        err.textContent = "⚠ " + friendly;
        quizContent.appendChild(err);
        const retryBtn = document.createElement("button");
        retryBtn.textContent = "↻ Try again";
        retryBtn.addEventListener("click", () => quizBtn.click());
        quizContent.appendChild(retryBtn);
      }
      if (msg.context === "generate_summary" && wrapupOverlay.classList.contains("open")) {
        wrapupContent.textContent = "";
        const err = document.createElement("div");
        err.className = "quiz-progress";
        err.textContent = "⚠ " + friendly;
        wrapupContent.appendChild(err);
        const retryBtn = document.createElement("button");
        retryBtn.textContent = "↻ Try again";
        retryBtn.addEventListener("click", () => wrapupBtn.click());
        wrapupContent.appendChild(retryBtn);
      }
    } else if (msg.type === "answer") {
      const node = nodeState[msg.node_id];
      if (node) {
        node.qa.push({ question: msg.question, answer: msg.answer });
        node.askPending = false;
        if (selectedNodeId === msg.node_id) renderPanel();
      }
    } else if (msg.type === "audio") {
      const node = nodeState[msg.node_id];
      if (node) {
        if (!node.audioUrls) node.audioUrls = {};
        node.audioUrls[msg.level] = msg.audio_url;
        node.audioPending = false;
        node.audioAutoplay = msg.level;
        if (selectedNodeId === msg.node_id) renderPanel();
      }
    } else if (msg.type === "level_intent") {
      // spoken command ("explain that simpler") matched server-side by a
      // local regex - no LLM call, so it lands instantly.
      const node = nodeState[msg.node_id];
      if (node) {
        node.level = msg.level;
        setStatus(`🎙 "${msg.phrase}" → level ${msg.level}`, "ok");
        if (selectedNodeId === msg.node_id) renderPanel();
        if (msg.level === 3 && !node.deep) requestDeep(node);
      }
    } else if (msg.type === "deep") {
      const node = nodeState[msg.node_id];
      if (node) {
        node.deep = msg.text;
        node.deepPending = false;
        node.level = 3;
        if (msg.cached) setStatus("⚡ instant - seen this concept before", "ok");
        refreshCardBacks();
        if (selectedNodeId === msg.node_id) renderPanel();
      }
    } else if (msg.type === "image") {
      const node = nodeState[msg.node_id];
      if (node) {
        node.image = msg.image_base64;
        node.imagePending = false;
        if (msg.cached) setStatus("⚡ instant - seen this concept before", "ok");
        if (selectedNodeId === msg.node_id) renderPanel();
      }
    } else if (msg.type === "widget") {
      const node = nodeState[msg.node_id];
      if (node) {
        node.widgetHtml = msg.html;
        node.widgetPending = false;
        if (msg.cached) setStatus("⚡ instant - seen this concept before", "ok");
        if (selectedNodeId === msg.node_id) renderPanel();
      }
    } else if (msg.type === "video") {
      const node = nodeState[msg.node_id];
      if (node) {
        node.videoUrl = msg.video_url;
        node.videoPending = false;
        if (msg.cached) setStatus("⚡ instant - seen this concept before", "ok");
        if (selectedNodeId === msg.node_id) renderPanel();
      }
    } else if (msg.type === "quiz") {
      startQuiz(msg.questions);
    } else if (msg.type === "summary") {
      renderWrapup(msg.summary);
    } else if (msg.type === "check_question") {
      const node = nodeState[msg.node_id];
      if (node) {
        node.checkQuestion = msg.question;
        node.checkPending = false;
        if (selectedNodeId === msg.node_id) renderPanel();
      }
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    // always try to reconnect now, regardless of `listening` - the
    // connection is what powers ask/quiz/simulations/wrap-up too, not just
    // the mic pipeline, so it should never just stay dead.
    setStatus("reconnecting...", "err");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };

  ws.onerror = () => setStatus("connection error - retrying...", "err");
}

// ---------- ElevenLabs Scribe realtime: mic -> PCM16 16kHz -> our backend
// websocket -> ElevenLabs. The API key stays server-side, and the browser
// never has to be Chrome/Edge (no Web Speech API involved). ----------
async function startElevenLabsCapture() {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  } catch (e) {
    listening = false;
    startBtn.textContent = "▶ Start listening";
    startBtn.classList.remove("active");
    showToast("Mic permission denied - allow microphone access, or use the text box below instead.", "err");
    return;
  }

  // asking the AudioContext for 16kHz directly means no manual resampling:
  // it's exactly the rate the realtime API expects (pcm_16000).
  audioContext = new AudioContext({ sampleRate: 16000 });
  await audioContext.resume();
  audioSource = audioContext.createMediaStreamSource(audioStream);
  audioNode = audioContext.createScriptProcessor(4096, 1, 1);

  audioNode.onaudioprocess = (event) => {
    if (!listening || !wsReady()) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    let binary = "";
    const bytes = new Uint8Array(pcm.buffer);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    ws.send(JSON.stringify({ type: "audio_chunk", audio_base_64: btoa(binary) }));
  };

  audioSource.connect(audioNode);
  // ScriptProcessor only fires while connected to a destination; a zero-gain
  // node keeps it running without playing the mic back through the speakers.
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  audioNode.connect(mute);
  mute.connect(audioContext.destination);
  setStatus("listening 🎙️ (ElevenLabs Scribe)", "ok");
}

function stopElevenLabsCapture() {
  if (audioNode) { try { audioNode.disconnect(); } catch (e) {} audioNode = null; }
  if (audioSource) { try { audioSource.disconnect(); } catch (e) {} audioSource = null; }
  if (audioContext) { try { audioContext.close(); } catch (e) {} audioContext = null; }
  if (audioStream) { audioStream.getTracks().forEach((t) => t.stop()); audioStream = null; }
  partialTranscript = "";
  renderTranscript();
  if (wsReady()) ws.send(JSON.stringify({ type: "audio_stop" }));
}


// ---------- pan / zoom (pointer events: mouse + touch + pinch) ----------
let panX = 0, panY = 0, zoom = 1;
let isDragging = false, dragStart = { x: 0, y: 0 }, panStart = { x: 0, y: 0 };
const activePointers = new Map();
let lastPinchDist = null;

function applyTransform() {
  canvasEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

viewport.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".card")) return;
  viewport.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 1) {
    isDragging = true;
    viewport.classList.add("dragging");
    dragStart = { x: e.clientX, y: e.clientY };
    panStart = { x: panX, y: panY };
  }
});

viewport.addEventListener("pointermove", (e) => {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (activePointers.size === 2) {
    const pts = [...activePointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (lastPinchDist != null) {
      zoom = Math.min(2.5, Math.max(0.2, zoom * (dist / lastPinchDist)));
      applyTransform();
    }
    lastPinchDist = dist;
  } else if (activePointers.size === 1 && isDragging) {
    panX = panStart.x + (e.clientX - dragStart.x);
    panY = panStart.y + (e.clientY - dragStart.y);
    applyTransform();
  }
});

function endPointer(e) {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) lastPinchDist = null;
  if (activePointers.size === 0) { isDragging = false; viewport.classList.remove("dragging"); }
}
viewport.addEventListener("pointerup", endPointer);
viewport.addEventListener("pointercancel", endPointer);

viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoom = Math.min(2.5, Math.max(0.2, zoom - e.deltaY * 0.001));
  applyTransform();
}, { passive: false });

// ---------- fit-to-view: computes the bounding box of every node and sets
// pan/zoom so the whole graph is framed, instead of manually guessing ----------
function fitToView() {
  const ids = Object.keys(nodeState);
  if (!ids.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) {
    const n = nodeState[id];
    const w = n.w || BASE_CARD_W, h = n.h || BASE_CARD_H;
    minX = Math.min(minX, n.x - w / 2); maxX = Math.max(maxX, n.x + w / 2);
    minY = Math.min(minY, n.y - h / 2); maxY = Math.max(maxY, n.y + h / 2);
  }
  const graphW = maxX - minX, graphH = maxY - minY;
  const vw = viewport.clientWidth, vh = viewport.clientHeight;
  const padding = 60;
  zoom = Math.min(2.5, Math.max(0.15, Math.min((vw - padding * 2) / graphW, (vh - padding * 2) / graphH)));
  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
  panX = -centerX * zoom;
  panY = -centerY * zoom;
  applyTransform();
}
fitViewBtn.addEventListener("click", fitToView);

// ---------- quiz: one batch call over the whole map, cheap regardless of
// how many concepts exist. Not cached - the map keeps growing, so a quiz
// should reflect what's on it right now, not a stale earlier snapshot. ----------
let quizState = null; // {questions, index, score, answered}

quizBtn.addEventListener("click", () => {
  quizOverlay.classList.add("open"); // open first so wsReady()'s toast is visible against it
  if (!wsReady()) return;
  quizContent.textContent = "";
  const loading = document.createElement("div");
  loading.className = "quiz-progress";
  loading.textContent = "Generating quiz from everything covered so far...";
  quizContent.appendChild(loading);
  ws.send(JSON.stringify({ type: "generate_quiz" }));
});

quizOverlayClose.addEventListener("click", () => quizOverlay.classList.remove("open"));
quizOverlay.addEventListener("click", (e) => { if (e.target === quizOverlay) quizOverlay.classList.remove("open"); });

// ---------- wrap-up: a nice "webpage" summary. Purely a view - closing it
// (or never opening it) leaves the live mind-map and every other feature
// exactly as functional as before, since generating it never touches the
// graph. "Wrap up" replaces the old "Generate diagram now" button, which
// was redundant with the automatic ~20s timer. ----------
wrapupBtn.addEventListener("click", () => {
  wrapupOverlay.classList.add("open");
  if (!wsReady()) return;
  wrapupContent.textContent = "";
  const loading = document.createElement("div");
  loading.className = "quiz-progress";
  loading.textContent = "Summarizing everything covered so far...";
  wrapupContent.appendChild(loading);
  ws.send(JSON.stringify({ type: "generate_summary" }));
});

wrapupClose.addEventListener("click", () => wrapupOverlay.classList.remove("open"));

function renderWrapup(summary) {
  wrapupContent.textContent = "";
  if (!summary || !summary.bullets || !summary.bullets.length) {
    const msg = document.createElement("div");
    msg.className = "quiz-progress";
    msg.textContent = "Not enough on the map yet to summarize - keep listening a bit longer.";
    wrapupContent.appendChild(msg);
    return;
  }

  const title = document.createElement("h1");
  title.className = "wrapup-title";
  title.textContent = summary.title;
  wrapupContent.appendChild(title);

  const subtitle = document.createElement("div");
  subtitle.className = "wrapup-subtitle";
  subtitle.textContent = `${Object.keys(nodeState).length} concepts covered`;
  wrapupContent.appendChild(subtitle);

  const list = document.createElement("ul");
  list.className = "wrapup-bullets";
  for (const bullet of summary.bullets) {
    const li = document.createElement("li");
    li.textContent = bullet;
    list.appendChild(li);
  }
  wrapupContent.appendChild(list);

  const hint = document.createElement("div");
  hint.className = "wrapup-hint";
  hint.textContent = "Close this and keep going - the map, simulations, and everything else are still right here.";
  wrapupContent.appendChild(hint);
}

function startQuiz(questions) {
  if (!questions || !questions.length) {
    quizContent.textContent = "";
    const msg = document.createElement("div");
    msg.className = "quiz-progress";
    msg.textContent = "Not enough on the map yet to build a quiz - keep listening a bit longer.";
    quizContent.appendChild(msg);
    return;
  }
  quizState = { questions, index: 0, score: 0, answered: false };
  renderQuizQuestion();
}

// Shared by the whole-lecture quiz AND the per-simulation check question
// (active recall, click an option -> immediate correct/wrong + explanation).
// `onAnswered(wasCorrect)` fires once, after the explanation is shown.
function buildQuestionElement(q, onAnswered) {
  const wrap = document.createElement("div");
  wrap.className = "quiz-question-block";

  const question = document.createElement("div");
  question.className = "quiz-question";
  question.textContent = q.question;
  wrap.appendChild(question);

  const optionsWrap = document.createElement("div");
  optionsWrap.className = "quiz-options";
  let answered = false;
  q.options.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.className = "quiz-option";
    btn.textContent = opt;
    btn.addEventListener("click", () => {
      if (answered) return;
      answered = true;
      const correct = i === q.correct_index;
      [...optionsWrap.children].forEach((b, j) => {
        b.disabled = true;
        if (j === q.correct_index) b.classList.add("correct");
        else if (j === i) b.classList.add("wrong");
      });
      const explanation = document.createElement("div");
      explanation.className = "quiz-explanation";
      explanation.textContent = (correct ? "✅ Correct. " : "❌ Not quite. ") + (q.explanation || "");
      wrap.appendChild(explanation);
      if (onAnswered) onAnswered(correct);
    });
    optionsWrap.appendChild(btn);
  });
  wrap.appendChild(optionsWrap);
  return wrap;
}

function renderQuizQuestion() {
  quizContent.textContent = "";
  const { questions, index } = quizState;
  const q = questions[index];

  const progress = document.createElement("div");
  progress.className = "quiz-progress";
  progress.textContent = `Question ${index + 1} of ${questions.length}`;
  quizContent.appendChild(progress);

  quizContent.appendChild(buildQuestionElement(q, (correct) => {
    if (correct) quizState.score++;
    const nav = document.createElement("div");
    nav.className = "quiz-nav";
    const nextBtn = document.createElement("button");
    nextBtn.textContent = quizState.index < quizState.questions.length - 1 ? "Next question →" : "See results";
    nextBtn.addEventListener("click", () => {
      quizState.index++;
      if (quizState.index < quizState.questions.length) renderQuizQuestion();
      else renderQuizResults();
    });
    nav.appendChild(nextBtn);
    quizContent.appendChild(nav);
  }));
}

function renderQuizResults() {
  quizContent.textContent = "";
  const score = document.createElement("div");
  score.className = "quiz-score";
  score.textContent = `${quizState.score} / ${quizState.questions.length} correct`;
  quizContent.appendChild(score);

  const retakeBtn = document.createElement("button");
  retakeBtn.textContent = "↻ Retake";
  retakeBtn.addEventListener("click", () => { quizState.index = 0; quizState.score = 0; quizState.answered = false; renderQuizQuestion(); });
  quizContent.appendChild(retakeBtn);
}
