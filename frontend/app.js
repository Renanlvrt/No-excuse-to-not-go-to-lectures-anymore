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

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let fullTranscript = "";
let ws;
let listening = false;      // mic/speech-recognition state
let wsConnected = false;    // websocket state - INDEPENDENT of listening now,
// so ask/quiz/simulations/wrap-up etc. keep working after you hit Stop
let reconnectDelay = 1000;
let selectedNodeId = null;
let recognitionInstance = null;

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

// ---------- category colors ----------
const CATEGORY_COLORS = {
  math: "#5b8def", code: "#8a5cf6", process: "#f5a623", theory: "#2fb380",
  warning: "#e5484d", definition: "#6b7280", interactive: "#00acc1",
};
function colorForCategory(cat) {
  if (CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
  let hash = 0;
  for (const ch of String(cat || "default")) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash}, 62%, 55%)`;
}

// ---------- node/graph state ----------
// nodeState[id] doubles as the d3 simulation's node object (x/y/vx/vy live
// directly on it) AND our app metadata (label/definition/qa/image/etc).
const nodeState = {};
window.nodeState = nodeState; // exposed for automated verification (see SUCCESS_CRITERIA.md)
const nodesArr = [];
let linksArr = [];
const cardEls = {};   // id -> card DOM element
const edgeEls = {};   // "from|to" -> {line, label}

const CARD_W = 190, CARD_H = 110;

// ---------- d3-force simulation ----------
function rectCollideForce() {
  let nodes;
  function force() {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const overlapX = CARD_W - Math.abs(dx);
        const overlapY = CARD_H - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX < overlapY) {
            const push = overlapX / 2 * (dx >= 0 ? 1 : -1) || 1;
            a.vx -= push; b.vx += push;
          } else {
            const push = overlapY / 2 * (dy >= 0 ? 1 : -1) || 1;
            a.vy -= push; b.vy += push;
          }
        }
      }
    }
  }
  force.initialize = (n) => { nodes = n; };
  return force;
}

// Tuned tighter than the initial defaults: the graph was spreading out
// with large dead gaps between clusters, forcing zoom-out far enough that
// labels became unreadable at scale (direct feedback). Less repulsion +
// shorter links + a stronger center pull keeps it compact without
// reintroducing card overlap (rectCollide still guarantees that separately).
const simulation = d3.forceSimulation([])
  .force("charge", d3.forceManyBody().strength(-260))
  .force("link", d3.forceLink([]).id((d) => d.id).distance(140))
  .force("center", d3.forceCenter(0, 0).strength(0.06))
  .force("rectCollide", rectCollideForce())
  .on("tick", onTick);

function onTick() {
  for (const id in cardEls) {
    const n = nodeState[id];
    cardEls[id].style.transform = `translate(${n.x}px, ${n.y}px)`;
  }
  drawEdges();
}

function drawEdges() {
  for (const key in edgeEls) {
    const { line, labelEl } = edgeEls[key];
    const [fromId, toId] = key.split("|");
    const a = nodeState[fromId], b = nodeState[toId];
    if (!a || !b) continue;
    line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
    labelEl.setAttribute("x", (a.x + b.x) / 2);
    labelEl.setAttribute("y", (a.y + b.y) / 2 - 4);
  }
}

// ---------- graph merge (never delete, reheat sim gently on new nodes) ----------
function mergeGraph(data) {
  const parentOf = {};
  for (const e of data.edges || []) parentOf[e.to] = e.from;

  let addedAny = false;
  for (const n of data.nodes || []) {
    if (nodeState[n.id]) {
      Object.assign(nodeState[n.id], {
        label: n.label, definition: n.definition, analogy: n.analogy, category: n.category,
        mode: n.mode, steps: n.steps || [],
      });
    } else {
      const parentId = parentOf[n.id];
      let x, y;
      if (parentId && nodeState[parentId]) {
        x = nodeState[parentId].x + (Math.random() - 0.5) * 40;
        y = nodeState[parentId].y + 160 + (Math.random() - 0.5) * 40;
      } else {
        x = (Math.random() - 0.5) * 120;
        y = (Math.random() - 0.5) * 120;
      }
      const node = Object.assign(
        {
          x, y, vx: 0, vy: 0, qa: [], image: null, widgetHtml: null,
          isNew: true, playing: false, currentStep: -1, pausedAtStep: null,
          lastError: null,
          // Persisted (not just local DOM state) so a pending request
          // survives navigating to another node and back - previously this
          // only lived on the button element itself, so clicking away made
          // an in-flight generation look "lost" and let a second click
          // double-fire a duplicate request for the same node.
          widgetPending: false, imagePending: false, askPending: false,
          videoPending: false, videoUrl: null,
          checkPending: false, checkQuestion: null, checkAnswered: false,
        },
        n, { steps: n.steps || [] }
      );
      nodeState[n.id] = node;
      nodesArr.push(node);
      addedAny = true;
    }
  }

  linksArr = (data.edges || [])
    .filter((e) => nodeState[e.from] && nodeState[e.to])
    .map((e) => ({ source: e.from, target: e.to, label: e.label }));

  simulation.nodes(nodesArr);
  simulation.force("link").links(linksArr);
  if (addedAny) simulation.alpha(0.6).restart();

  renderAllCards();
  renderEdgeElements();
  if (nodesArr.length) placeholderHint.style.display = "none";
}

function renderEdgeElements() {
  for (const e of linksArr) {
    const fromId = typeof e.source === "object" ? e.source.id : e.source;
    const toId = typeof e.target === "object" ? e.target.id : e.target;
    const key = `${fromId}|${toId}`;
    if (!edgeEls[key]) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      const labelEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      labelEl.setAttribute("text-anchor", "middle");
      labelEl.textContent = e.label || "";
      edgeLayer.appendChild(line);
      edgeLayer.appendChild(labelEl);
      edgeEls[key] = { line, labelEl };
    }
  }
}

// ---------- card rendering (lightweight: label + tiny flip-back definition) ----------
function renderAllCards() {
  for (const id in nodeState) {
    if (!cardEls[id]) createCard(nodeState[id]);
  }
}

function createCard(node) {
  const card = document.createElement("div");
  card.className = "card entering";
  card.dataset.nodeId = node.id;

  const inner = document.createElement("div");
  inner.className = "card-inner";

  const front = document.createElement("div");
  front.className = "card-face card-front";
  front.style.setProperty("--card-color", colorForCategory(node.category));
  const badge = document.createElement("div");
  badge.className = "card-badge";
  badge.textContent = node.category || "concept";
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
  back.style.setProperty("--card-color", colorForCategory(node.category));
  const def = document.createElement("div");
  def.className = "card-definition";
  def.textContent = node.definition || node.label;
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

  const badge = document.createElement("div");
  badge.className = "card-badge";
  badge.style.setProperty("--card-color", colorForCategory(node.category));
  badge.textContent = node.category || "concept";
  panelEl.appendChild(badge);

  const title = document.createElement("h2");
  title.className = "panel-title";
  title.textContent = node.label;
  panelEl.appendChild(title);

  if (node.analogy) {
    const analogy = document.createElement("p");
    analogy.className = "panel-analogy";
    analogy.textContent = "💡 " + node.analogy;
    panelEl.appendChild(analogy);
  }

  const def = document.createElement("p");
  def.className = "panel-definition";
  def.textContent = node.definition || "";
  panelEl.appendChild(def);

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
    if (recognitionInstance) { try { recognitionInstance.stop(); } catch (e) {} }
    setStatus(wsConnected ? "stopped listening (still connected)" : "stopped", "ok");
    return;
  }
  listening = true;
  startBtn.textContent = "■ Stop";
  startBtn.classList.add("active");
  if (SpeechRecognition) startRecognition();
  else showToast("Speech recognition not supported in this browser - use the text box below instead.", "err");
};

manualInput.addEventListener("input", () => {
  if (!wsReady()) return;
  const text = (fullTranscript + " " + manualInput.value).trim();
  ws.send(JSON.stringify({ text }));
});

function connect() {
  setStatus("connecting...");
  ws = new WebSocket(`ws://${location.host}/ws/lecture`);

  ws.onopen = () => {
    wsConnected = true;
    setStatus(listening ? "listening 🎙️" : "connected", "ok");
    reconnectDelay = 1000;
    const combined = (fullTranscript + " " + manualInput.value).trim();
    if (combined) ws.send(JSON.stringify({ text: combined }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "diagram") {
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
        generate_quiz: "Couldn't generate the quiz - try again.",
        generate_summary: "Couldn't generate the wrap-up summary - try again.",
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

function startRecognition() {
  const recognition = new SpeechRecognition();
  recognitionInstance = recognition; // so Stop can actually call .stop() on it
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = "en-US";

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        fullTranscript += " " + event.results[i][0].transcript;
        transcriptEl.textContent = fullTranscript;
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ text: (fullTranscript + " " + manualInput.value).trim() }));
        }
      }
    }
  };

  recognition.onerror = (event) => {
    console.error("SpeechRecognition error:", event.error);
    if (event.error === "no-speech") return;
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      showToast("Mic permission denied - allow microphone access, or use the text box below instead.", "err");
      return;
    }
    if (event.error === "network") {
      showToast("Speech recognition needs network access and failed - use the text box below instead.", "err");
      return;
    }
    showToast(`Mic error: ${event.error} - use the text box below if this persists.`, "err");
  };

  recognition.onend = () => { if (listening) { try { recognition.start(); } catch (e) {} } };
  try { recognition.start(); } catch (e) { setStatus("Could not start microphone - use the text box below instead.", "err"); }
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
    minX = Math.min(minX, n.x - CARD_W / 2); maxX = Math.max(maxX, n.x + CARD_W / 2);
    minY = Math.min(minY, n.y - CARD_H / 2); maxY = Math.max(maxY, n.y + CARD_H / 2);
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
