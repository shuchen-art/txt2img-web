"use strict";

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const context = canvas.getContext("2d");
const ui = {
  mode: "ready", session: null, round: 1,
  strokes: [], pointer: null, pending: null, error: "",
  turns: [], completedSubmissions: new Set(), finalImage: null, revision: 0,
};

class RequestError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const response = await fetch(path, {
      ...options, signal: controller.signal,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    if (response.status === 204) return null;
    const body = await response.json();
    if (!response.ok) throw new RequestError(body.error?.code || "request_failed", body.error?.message || "Please try again.");
    return body;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError("network_error", "Connection interrupted. Your drawing is still here. Please retry.");
  } finally { clearTimeout(timeout); }
}

function textBlock(lines, className) {
  const block = document.createElement("div");
  block.className = className;
  for (const line of lines) {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    block.append(paragraph);
  }
  return block;
}

function announce(text) { $("announcement").textContent = text; }

function addTurn(round, lines) {
  const element = document.createElement("section");
  element.className = "turn";
  element.dataset.round = String(round);
  element.setAttribute("aria-label", `Attempt ${round}`);
  const instruction = textBlock(lines, "instructions");
  instruction.id = `instructions-${round}`;
  element.append(instruction);
  $("record").append(element);
  canvas.setAttribute("aria-describedby", instruction.id);
  ui.turns.push({ round, element, instruction, image: null, submissionId: null });
  ui.revision += 1;
  announce(lines.join(" "));
  return instruction;
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
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#000";
  context.fillStyle = "#000";
  context.lineWidth = 4.4;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of ui.strokes) {
    if (stroke.length === 1) {
      context.beginPath();
      context.arc(stroke[0].x, stroke[0].y, 2.2, 0, Math.PI * 2);
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
  const saveVisible = finished || (mode === "expired" && hasInk);
  const actions = {
    ready: "Start", starting: "Preparing…", drawing: "Submit", evaluating: "Evaluating…",
    accepted: "Start again", terminated: "Start again", expired: "Start again",
    "start-error": "Retry start", "submit-error": "Retry submit", closing: "Closing…",
  };
  $("primary").textContent = actions[mode];
  $("primary").disabled = busy || (drawing && (!hasInk || ui.pointer !== null));
  $("undo").hidden = !toolsVisible;
  $("clear").hidden = !toolsVisible;
  $("undo").disabled = !drawing || !hasInk || ui.pointer !== null;
  $("clear").disabled = !drawing || !hasInk || ui.pointer !== null;
  $("download").hidden = !saveVisible;
  $("download").disabled = busy;
  $("tools").hidden = !(toolsVisible || saveVisible);
  $("error").hidden = !ui.error;
  $("error").textContent = ui.error;
  if (ui.error) announce("");
  $("editor").hidden = !ui.turns.length || finished || Boolean(ui.turns.at(-1)?.image);
  $("controls").classList.toggle("start", !ui.turns.length);
  canvas.classList.toggle("drawable", drawing);
  canvas.setAttribute("aria-disabled", String(!drawing));
  $("editor").setAttribute("aria-busy", String(mode === "evaluating"));
}

function point(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
           y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)) };
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
  paint(); render();
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
  paint(); render();
}
canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);
canvas.addEventListener("lostpointercapture", finishStroke);

function undo() {
  if (ui.mode !== "drawing" || ui.pointer !== null) return;
  ui.strokes.pop(); ui.pending = null;
  paint(); render();
}
$("undo").addEventListener("click", undo);
canvas.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo(); }
});
$("clear").addEventListener("click", () => {
  if (ui.mode !== "drawing" || ui.pointer !== null) return;
  ui.strokes = []; ui.pending = null;
  paint(); render();
});

async function start() {
  ui.mode = "starting"; ui.error = ""; render();
  announce("Preparing an instruction.");
  try {
    const result = await request("/api/sessions", { method: "POST" });
    ui.session = result.session_id;
    ui.round = result.round;
    const anchor = addTurn(result.round, result.instructions);
    ui.mode = "drawing";
    render();
    void revealNewContent(anchor);
  } catch (error) {
    ui.mode = "start-error"; ui.error = error.message; render();
  }
}

function commitVerdict(result, submission) {
  if (ui.completedSubmissions.has(submission.submission_id)) return;
  const turn = ui.turns.at(-1);
  if (!turn || turn.round !== submission.round || turn.image) return;
  const image = document.createElement("img");
  image.className = "drawing";
  image.src = `data:image/png;base64,${submission.image_base64}`;
  image.alt = `Drawing, attempt ${submission.round}`;
  image.width = canvas.width;
  image.height = canvas.height;
  image.draggable = false;
  turn.element.append(image);
  turn.image = image;
  turn.submissionId = submission.submission_id;
  ui.completedSubmissions.add(submission.submission_id);
  ui.finalImage = image.src;
  ui.pending = null;
  let anchor;
  if (result.state === "retry") {
    ui.round = result.next_round;
    ui.strokes = [];
    paint();
    anchor = addTurn(result.next_round, result.feedback);
    ui.mode = "drawing";
  } else {
    ui.mode = result.state;
    anchor = textBlock(result.feedback, "verdict");
    anchor.setAttribute("aria-label", "Final decision");
    $("record").append(anchor);
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
  ui.pending ||= { submission_id: submissionId(), round: ui.round,
                   image_base64: canvas.toDataURL("image/png").split(",")[1] };
  const submission = ui.pending;
  ui.mode = "evaluating"; ui.error = ""; render();
  announce("Evaluating drawing.");
  try {
    const result = await request(`/api/sessions/${ui.session}/drawings`, { method: "POST", body: JSON.stringify(submission) });
    commitVerdict(result, submission);
  } catch (error) {
    ui.error = error.message;
    ui.mode = ["session_expired", "session_closed", "round_conflict", "submission_conflict"].includes(error.code) ? "expired" : "submit-error";
    render();
  }
}

async function restart() {
  const oldMode = ui.mode;
  ui.mode = "closing"; ui.error = ""; render();
  try {
    if (ui.session) await request(`/api/sessions/${ui.session}`, { method: "DELETE" });
    ui.revision += 1;
    ui.session = null; ui.round = 1;
    ui.pending = null; ui.strokes = []; ui.turns = []; ui.finalImage = null;
    ui.completedSubmissions.clear();
    $("record").replaceChildren();
    canvas.removeAttribute("aria-describedby");
    paint();
    await start();
  } catch (error) { ui.mode = oldMode; ui.error = error.message; render(); }
}

$("primary").addEventListener("click", () => {
  if (["ready", "start-error"].includes(ui.mode)) return start();
  if (["drawing", "submit-error"].includes(ui.mode)) return submit();
  if (["accepted", "terminated", "expired"].includes(ui.mode)) return restart();
});
$("download").addEventListener("click", () => {
  const source = ["accepted", "terminated"].includes(ui.mode) ? ui.finalImage : canvas.toDataURL("image/png");
  if (!source) return;
  const bytes = Uint8Array.from(atob(source.split(",")[1]), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `txt2img-inverse-attempt-${ui.round}.png`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

// Fixed intrinsic dimensions preserve ink across resizing. Only the live canvas handles pointers.
paint(); render();
