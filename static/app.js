"use strict";

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const context = canvas.getContext("2d");
const drawingInk = getComputedStyle(document.documentElement).getPropertyValue("--ink-primary").trim();
const editorEl = $("editor");
const editorDockEl = $("editor-dock");
const placeholderEl = $("placeholder");
const emailInput = $("email");

function pad2(number) {
  return String(number).padStart(2, "0");
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatClock(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(minutes)}m ${pad2(seconds)}s`;
}

const isLocalHost = ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname);
const configuredApiBase = (window.TXT2IMG_CONFIG?.apiBase || "").trim().replace(/\/+$/, "");
const API_BASE = isLocalHost ? "" : configuredApiBase;

const ui = {
  mode: "ready",
  session: null,
  sessionStartedAt: null,
  email: emailInput.value.trim(),
  authenticated: false,
  ownerToken: "",
  modelId: "UNVERIFIED",
  round: 1,
  strokes: [],
  pointer: null,
  pending: null,
  error: "",
  turns: [],
  completedSubmissions: new Set(),
  revision: 0,
};

class RequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const headers = { "Content-Type": "application/json", ...options.headers };
    if (ui.ownerToken) headers.Authorization = `Bearer ${ui.ownerToken}`;
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers,
    });
    if (response.status === 204) return null;
    const body = await response.json();
    if (!response.ok) {
      throw new RequestError(body.error?.code || "request_failed", body.error?.message || "Please try again.");
    }
    return body;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError("network_error", "Connection interrupted. Your drawing is still here. Please retry.");
  } finally {
    clearTimeout(timeout);
  }
}

function fillLines(container, lines) {
  container.replaceChildren();
  for (const line of lines) {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    container.append(paragraph);
  }
}

function announce(text) {
  $("announcement").textContent = text;
}

function updateMetadata(date = new Date()) {
  $("meta-model").textContent = ui.modelId;
  $("meta-date").textContent = formatDate(date);
}

function parkEditor() {
  if (editorEl.parentElement !== editorDockEl) editorDockEl.append(editorEl);
  editorEl.hidden = true;
}

function createViewportDecorations() {
  const fragment = document.createDocumentFragment();
  const frame = document.createElement("div");
  frame.className = "capture-frame";
  frame.setAttribute("aria-hidden", "true");
  const ticks = document.createElement("div");
  ticks.className = "corner-ticks";
  ticks.setAttribute("aria-hidden", "true");
  for (const corner of ["tl", "tr", "bl", "br"]) {
    const tick = document.createElement("span");
    tick.className = `tick tick-${corner}`;
    ticks.append(tick);
  }
  fragment.append(frame, ticks);
  return fragment;
}

function addTurn(round, lines, timestamp = new Date()) {
  const record = $("record");
  if (ui.turns.length > 0) {
    const divider = document.createElement("div");
    divider.className = "divider divider-dashed";
    divider.setAttribute("aria-hidden", "true");
    record.append(divider);
  }

  const roundCode = pad2(round);
  const promptCommandText = round === 1 ? "> ai.prompt(init)" : `> ai.critique_and_prompt(${roundCode})`;

  const element = document.createElement("section");
  element.className = "turn";
  element.dataset.round = String(round);
  element.setAttribute("aria-label", `Attempt ${round}`);

  const header = document.createElement("div");
  header.className = "trial-header";
  const badge = document.createElement("span");
  badge.className = "trial-badge";
  badge.textContent = `TRIAL ${roundCode} / 04`;
  const promptMeta = document.createElement("p");
  promptMeta.className = "trial-meta";
  promptMeta.textContent = formatClock(timestamp);
  header.append(badge, promptMeta);

  const promptSection = document.createElement("div");
  promptSection.className = "prompt-section";
  const promptCommand = document.createElement("p");
  promptCommand.className = "command-label";
  promptCommand.textContent = promptCommandText;
  const instruction = document.createElement("div");
  instruction.className = "instructions";
  instruction.id = `instructions-${round}`;
  fillLines(instruction, lines);
  promptSection.append(promptCommand, instruction);

  const captureSection = document.createElement("div");
  captureSection.className = "capture-section";
  const captureHeader = document.createElement("div");
  captureHeader.className = "capture-header";
  const captureCommand = document.createElement("p");
  captureCommand.className = "capture-command";
  captureCommand.textContent = `> human.submit(${roundCode})`;
  const captureMeta = document.createElement("p");
  captureMeta.className = "capture-meta";
  captureMeta.textContent = "AWAITING INPUT";
  captureHeader.append(captureCommand, captureMeta);

  const viewport = document.createElement("div");
  viewport.className = "capture-viewport";
  viewport.append(createViewportDecorations());
  captureSection.append(captureHeader, viewport);

  element.append(header, promptSection, captureSection);
  record.append(element);

  viewport.append(editorEl);

  canvas.setAttribute("aria-describedby", instruction.id);
  ui.turns.push({
    round,
    element,
    instruction,
    viewport,
    captureMeta,
    promptedAt: timestamp,
    image: null,
    submissionId: null,
  });
  ui.revision += 1;
  announce(lines.join(" "));
  return element;
}

async function revealNewContent(anchor) {
  const revision = ui.revision;
  // Font/image dimensions must settle before computing the new scroll position.
  await document.fonts.ready;
  await Promise.all([...$("record").querySelectorAll("img")].map((image) => image.decode().catch(() => {})));
  await new Promise(requestAnimationFrame);
  if (revision !== ui.revision || !anchor.isConnected) return;
  anchor.scrollIntoView({
    block: "start",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
  });
}

function paint() {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = drawingInk;
  context.fillStyle = drawingInk;
  context.lineWidth = 5.3;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of ui.strokes) {
    if (stroke.length === 1) {
      context.beginPath();
      context.arc(stroke[0].x, stroke[0].y, 2.65, 0, Math.PI * 2);
      context.fill();
    } else {
      context.beginPath();
      context.moveTo(stroke[0].x, stroke[0].y);
      for (const point of stroke.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
  }
}

function render() {
  const mode = ui.mode;
  const busy = ["starting", "evaluating", "closing"].includes(mode);
  const drawing = mode === "drawing";
  const finished = ["accepted", "terminated"].includes(mode);
  const hasInk = ui.strokes.length > 0;
  const toolsVisible = ["drawing", "evaluating"].includes(mode);
  const showAuth = !ui.turns.length && !ui.authenticated;
  const needEmail = !ui.turns.length && !ui.email;
  const actions = {
    ready: "[ START ]",
    starting: "[ PREPARING… ]",
    drawing: "[ SUBMIT ]",
    evaluating: "[ EVALUATING… ]",
    accepted: "[ START AGAIN ]",
    terminated: "[ START AGAIN ]",
    expired: "[ START AGAIN ]",
    "start-error": "[ RETRY START ]",
    "submit-error": "[ RETRY SUBMIT ]",
    closing: "[ CLOSING… ]",
  };

  $("record").hidden = !ui.turns.length;
  $("settlement").hidden = !finished;
  $("auth-box").hidden = !showAuth;
  emailInput.disabled = busy;

  $("primary").textContent = actions[mode];
  $("primary").disabled = busy || needEmail || (drawing && (!hasInk || ui.pointer !== null));
  $("undo").hidden = !toolsVisible;
  $("clear").hidden = !toolsVisible;
  $("undo").disabled = !drawing || !hasInk || ui.pointer !== null;
  $("clear").disabled = !drawing || !hasInk || ui.pointer !== null;
  $("tools").hidden = !toolsVisible;
  $("error").hidden = !ui.error;
  $("error").textContent = ui.error;
  if (ui.error) announce("");

  const activeTurn = ui.turns.at(-1);
  const editorVisible = Boolean(activeTurn && !finished && !activeTurn.image);
  if (!editorVisible) {
    parkEditor();
  } else {
    if (editorEl.parentElement !== activeTurn.viewport) activeTurn.viewport.append(editorEl);
    editorEl.hidden = false;
    const isEmpty = !hasInk && ui.pointer === null;
    placeholderEl.hidden = !isEmpty;
    activeTurn.captureMeta.textContent =
      mode === "evaluating" ? "EVALUATING…" :
      mode === "submit-error" ? "RETRY REQUIRED" :
      mode === "expired" ? "SESSION EXPIRED" :
      hasInk ? "INK RECORDED" : "AWAITING INPUT";
  }

  $("controls").classList.toggle("start", !ui.turns.length);
  canvas.classList.toggle("drawable", drawing);
  canvas.setAttribute("aria-disabled", String(!drawing));
  editorEl.setAttribute("aria-busy", String(mode === "evaluating"));
}

emailInput.addEventListener("input", () => {
  ui.email = emailInput.value.trim();
  if (ui.mode === "start-error") {
    ui.mode = "ready";
    ui.error = "";
  }
  render();
});

emailInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && ["ready", "start-error"].includes(ui.mode) && ui.email) {
    event.preventDefault();
    void start();
  }
});

function point(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)),
  };
}

canvas.addEventListener("pointerdown", (event) => {
  if (ui.mode !== "drawing" || ui.pointer !== null || event.button !== 0) return;
  event.preventDefault();
  canvas.focus({ preventScroll: true });
  ui.pointer = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  ui.strokes.push([point(event)]);
  ui.pending = null;
  ui.error = "";
  paint();
  render();
});

canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId !== ui.pointer) return;
  event.preventDefault();
  const events = event.getCoalescedEvents?.() || [];
  const stroke = ui.strokes.at(-1);
  context.beginPath();
  context.moveTo(stroke.at(-1).x, stroke.at(-1).y);
  for (const sample of events.length ? events : [event]) {
    const next = point(sample);
    stroke.push(next);
    context.lineTo(next.x, next.y);
  }
  context.stroke();
});

function finishStroke(event) {
  if (event.pointerId !== ui.pointer) return;
  ui.pointer = null;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  paint();
  render();
}

canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);
canvas.addEventListener("lostpointercapture", finishStroke);

function undo() {
  if (ui.mode !== "drawing" || ui.pointer !== null) return;
  ui.strokes.pop();
  ui.pending = null;
  paint();
  render();
}

$("undo").addEventListener("click", undo);
canvas.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
  }
});

$("clear").addEventListener("click", () => {
  if (ui.mode !== "drawing" || ui.pointer !== null) return;
  ui.strokes = [];
  ui.pending = null;
  paint();
  render();
});

async function start() {
  const email = ui.email || emailInput.value.trim();
  if (!email) {
    emailInput.focus();
    return;
  }
  ui.email = email;
  ui.mode = "starting";
  ui.error = "";
  render();
  announce("Preparing an instruction.");
  try {
    const result = await request("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    const startedAt = new Date();
    ui.session = result.session_id;
    ui.modelId = result.model_id;
    if (result.owner_token) ui.ownerToken = result.owner_token;
    ui.authenticated = true;
    ui.sessionStartedAt = startedAt;
    updateMetadata(startedAt);
    ui.round = result.round;
    const anchor = addTurn(result.round, result.instructions, startedAt);
    ui.mode = "drawing";
    render();
    void revealNewContent(anchor);
  } catch (error) {
    ui.mode = "start-error";
    ui.error = error.message;
    if (error.code === "email_not_allowed") {
      ui.authenticated = false;
      ui.ownerToken = "";
      ui.modelId = "UNVERIFIED";
      updateMetadata(new Date());
    }
    render();
    if (error.code === "email_not_allowed") emailInput.focus();
  }
}

function populateSettlement(state, feedback, completedRounds, endedAt) {
  const accepted = state === "accepted";
  const startedAt = ui.sessionStartedAt || endedAt;
  $("verdict-title").textContent = accepted ? "VERDICT // ACCEPTED" : "VERDICT // TERMINATED";
  $("verdict-badge").textContent = accepted ? "[ PASS ]" : "[ FAIL ]";
  fillLines($("verdict-body"), feedback);
  $("stat-trials").textContent = `${pad2(completedRounds)} / 04`;
  $("stat-elapsed").textContent =
    `${formatDuration(endedAt - startedAt)} (${formatClock(startedAt)} -> ${formatClock(endedAt)})`;
}

function commitVerdict(result, submission) {
  if (ui.completedSubmissions.has(submission.submission_id)) return;
  const turn = ui.turns.at(-1);
  if (!turn || turn.round !== submission.round || turn.image) return;

  const submittedAt = submission.submittedAt || new Date();
  const image = document.createElement("img");
  image.className = "drawing";
  image.src = `data:image/png;base64,${submission.image_base64}`;
  image.alt = `Drawing, attempt ${submission.round}`;
  image.width = canvas.width;
  image.height = canvas.height;
  image.draggable = false;

  parkEditor();
  turn.viewport.append(image);
  turn.captureMeta.textContent = `${formatClock(submittedAt)} (+${formatDuration(submittedAt - turn.promptedAt)})`;
  turn.image = image;
  turn.submissionId = submission.submission_id;

  ui.completedSubmissions.add(submission.submission_id);
  ui.pending = null;

  let anchor;
  if (result.state === "retry") {
    ui.round = result.next_round;
    ui.strokes = [];
    paint();
    anchor = addTurn(result.next_round, result.feedback, new Date());
    ui.mode = "drawing";
  } else {
    ui.mode = result.state;
    populateSettlement(result.state, result.feedback, ui.turns.length, submittedAt);
    anchor = $("settlement");
    ui.revision += 1;
    announce(result.feedback.join(" "));
  }
  render();
  void revealNewContent(anchor);
}

async function submit() {
  if (!["drawing", "submit-error"].includes(ui.mode) || !ui.strokes.length || ui.pointer !== null) return;
  // Preserve both bytes and ID until a verdict is retrieved, including after a lost response.
  const submissionId = () => crypto.randomUUID ? crypto.randomUUID() :
    "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (digit) =>
      (+digit ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+digit / 4)))).toString(16));
  ui.pending ||= {
    submission_id: submissionId(),
    round: ui.round,
    image_base64: canvas.toDataURL("image/png").split(",")[1],
    submittedAt: new Date(),
  };
  const submission = ui.pending;
  const payload = {
    submission_id: submission.submission_id,
    round: submission.round,
    image_base64: submission.image_base64,
  };
  ui.mode = "evaluating";
  ui.error = "";
  render();
  announce("Evaluating drawing.");
  try {
    const result = await request(`/api/sessions/${ui.session}/drawings`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    commitVerdict(result, submission);
  } catch (error) {
    ui.error = error.message;
    ui.mode = ["session_expired", "session_closed", "round_conflict", "submission_conflict"].includes(error.code)
      ? "expired"
      : "submit-error";
    render();
  }
}

async function restart() {
  const oldMode = ui.mode;
  ui.mode = "closing";
  ui.error = "";
  render();
  try {
    if (ui.session) await request(`/api/sessions/${ui.session}`, { method: "DELETE" });
    ui.revision += 1;
    ui.session = null;
    ui.sessionStartedAt = null;
    ui.round = 1;
    ui.pending = null;
    ui.strokes = [];
    ui.turns = [];
    ui.completedSubmissions.clear();
    parkEditor();
    $("record").replaceChildren();
    $("verdict-body").replaceChildren();
    canvas.removeAttribute("aria-describedby");
    updateMetadata(new Date());
    paint();
    await start();
  } catch (error) {
    ui.mode = oldMode;
    ui.error = error.message;
    render();
  }
}

$("primary").addEventListener("click", () => {
  if (["ready", "start-error"].includes(ui.mode)) return start();
  if (["drawing", "submit-error"].includes(ui.mode)) return submit();
  if (["accepted", "terminated", "expired"].includes(ui.mode)) return restart();
});

// Fixed intrinsic 4:3 dimensions preserve ink across resizing. Only the live canvas handles pointers.
updateMetadata(new Date());
paint();
render();
