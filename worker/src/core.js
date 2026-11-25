import { EMOTIONS, PROMPTS } from "./prompts.js";

export const MAX_PNG_BYTES = 2 * 1024 * 1024;
export const MAX_BODY_BYTES = 3 * 1024 * 1024;
export const SESSION_TTL_MS = 30 * 60 * 1000;
export const AI_TIMEOUT_MS = 45_000;

const MAX_BASE64_LEN = Math.ceil(MAX_PNG_BYTES / 3) * 4;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class APIError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.message = message;
    this.status = status;
  }
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export async function deriveHumanId(normalizedEmail) {
  const bytes = new TextEncoder().encode(normalizedEmail);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const value = new DataView(digest).getUint32(0, false);
  return `Human #${10000 + (value % 90000)}`;
}

function splitFirst(text, sep) {
  const idx = text.indexOf(sep);
  if (idx === -1) return [text.trim(), ""];
  return [text.slice(0, idx).trim(), text.slice(idx + 1).trim()];
}

export async function parseAllowlist(rawAllowlist) {
  const entries = new Map();
  if (!rawAllowlist || typeof rawAllowlist !== "string") return entries;

  const chunks = [];
  for (const line of rawAllowlist.split(/\r?\n|;/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Allow single-line comma-separated lists like "a@x.com:Human #1, b@y.com:Human #2"
    // while keeping CSV rows like "a@x.com,Human #1" intact.
    const commaParts = trimmed.split(",");
    if (commaParts.length > 2 || (commaParts.length === 2 && commaParts[1].includes("@"))) {
      for (const part of commaParts) {
        const sub = part.trim();
        if (sub) chunks.push(sub);
      }
    } else {
      chunks.push(trimmed);
    }
  }

  for (const item of chunks) {
    let rawEmail = "";
    let rawId = "";
    if (item.includes("=") && (!item.includes(",") || item.indexOf("=") < item.indexOf(","))) {
      [rawEmail, rawId] = splitFirst(item, "=");
    } else if (item.includes(":") && (!item.includes(",") || item.indexOf(":") < item.indexOf(","))) {
      [rawEmail, rawId] = splitFirst(item, ":");
    } else if (item.includes(",")) {
      [rawEmail, rawId] = splitFirst(item, ",");
    } else {
      rawEmail = item;
    }

    const lowered = normalizeEmail(rawEmail);
    if (!lowered) continue;
    if (lowered === "email" && ["", "human_id", "model_id"].includes(rawId.toLowerCase())) continue;
    entries.set(lowered, rawId || (await deriveHumanId(lowered)));
  }

  return entries;
}

export async function resolveAllowlistEmail(rawAllowlist, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const entries = await parseAllowlist(rawAllowlist);
  return entries.get(normalized) ?? null;
}

export function validatePngBase64(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_BASE64_LEN) {
    throw new APIError("invalid_image", "Submit a valid PNG drawing.");
  }
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new APIError("invalid_image", "Submit a valid PNG drawing.");
  }

  let binary;
  try {
    binary = atob(encoded);
  } catch {
    throw new APIError("invalid_image", "Submit a valid PNG drawing.");
  }

  if (binary.length > MAX_PNG_BYTES) {
    throw new APIError("image_too_large", "The drawing is too large to submit.", 413);
  }
  if (binary.length < 33) {
    throw new APIError("invalid_image", "Submit a single PNG drawing.");
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new APIError("invalid_image", "Submit a single PNG drawing.");
    }
  }

  const view = new DataView(bytes.buffer);
  const ihdrLen = view.getUint32(8, false);
  const ihdrType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (ihdrLen !== 13 || ihdrType !== "IHDR") {
    throw new APIError("invalid_image", "The drawing could not be read. Please try again.");
  }

  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (Math.min(width, height) < 16 || Math.max(width, height) > 2048) {
    throw new APIError("invalid_dimensions", "The drawing dimensions are not supported.");
  }

  let offset = 8;
  let sawIdat = false;
  let sawIend = false;
  while (offset + 12 <= bytes.length) {
    const chunkLen = view.getUint32(offset, false);
    const chunkType = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const nextOffset = offset + 12 + chunkLen;
    if (chunkLen > MAX_PNG_BYTES || nextOffset > bytes.length) {
      throw new APIError("invalid_image", "The drawing could not be read. Please try again.");
    }
    if (chunkType === "acTL") {
      throw new APIError("invalid_image", "Submit a single PNG drawing.");
    }
    if (chunkType === "IDAT") sawIdat = true;
    if (chunkType === "IEND") {
      sawIend = true;
      break;
    }
    offset = nextOffset;
  }

  if (!sawIdat || !sawIend) {
    throw new APIError("invalid_image", "The drawing could not be read. Please try again.");
  }
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i += 1) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

export function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sampleThreeEmotions() {
  const pool = [...EMOTIONS];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const rand = new Uint32Array(1);
    crypto.getRandomValues(rand);
    const j = rand[0] % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 3).join(", ");
}

function validateFeedbackJson(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new APIError("invalid_ai_response", "The evaluator returned an unreadable response. Please try again.", 502);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new APIError("invalid_ai_response", "The evaluator returned an unreadable response. Please try again.", 502);
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 3 || !keys.includes("detail") || !keys.includes("is_satisfied") || !keys.includes("feedback")) {
    throw new APIError("invalid_ai_response", "The evaluator returned an unreadable response. Please try again.", 502);
  }
  if (typeof parsed.detail !== "string" || parsed.detail.length < 1 || parsed.detail.length > 4000) {
    throw new APIError("invalid_ai_response", "The evaluator returned an unreadable response. Please try again.", 502);
  }
  if (typeof parsed.is_satisfied !== "boolean") {
    throw new APIError("invalid_ai_response", "The evaluator returned an unreadable response. Please try again.", 502);
  }
  if (!Array.isArray(parsed.feedback) || parsed.feedback.length !== 3) {
    throw new APIError("invalid_ai_response", "The evaluator returned an unreadable response. Please try again.", 502);
  }
  for (const line of parsed.feedback) {
    if (typeof line !== "string" || !line.trim() || line.length > 160) {
      throw new APIError("invalid_ai_response", "The evaluator returned an unreadable response. Please try again.", 502);
    }
  }
  return parsed;
}

export function createDeepSeekClient({
  apiKey,
  model = "deepseek-flash",
  fetchImpl = fetch,
  timeoutMs = AI_TIMEOUT_MS,
} = {}) {
  const trimmedKey = (apiKey || "").trim();
  if (!trimmedKey) {
    const fail = async () => {
      throw new APIError("ai_not_configured", "The terminal is not connected yet. Please try again later.", 503);
    };
    return { initial: fail, evaluate: fail };
  }

  async function generate(history, content) {
    const userTurn = { role: "user", content };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl("https://api.deepseek.com/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${trimmedKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: (model || "").trim() || "deepseek-flash",
          messages: [{ role: "system", content: PROMPTS.system }, ...history, userTurn],
          response_format: { type: "json_object" },
          thinking: { type: "disabled" },
          temperature: 1.0,
          max_tokens: 2048,
          stream: false,
        }),
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new APIError("ai_timeout", "The evaluator took too long. Please retry; this attempt was not counted.", 504);
      }
      throw new APIError("ai_unavailable", "The evaluator could not be reached. Please try again.", 502);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const status = response.status;
      if (status === 429) {
        throw new APIError("ai_busy", "The evaluator is busy. Your drawing is safe; please try again shortly.", 503);
      }
      if (status === 401 || status === 402 || status === 403) {
        throw new APIError("ai_not_available", "The terminal is temporarily unavailable. Please try again later.", 503);
      }
      throw new APIError("ai_unavailable", "The evaluator could not be reached. Please try again.", 502);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new APIError("invalid_ai_response", "The evaluator returned an unreadable response. Please try again.", 502);
    }

    const choice = payload?.choices?.[0];
    const message = choice?.message;
    if (!choice || choice.finish_reason !== "stop" || message?.refusal || typeof message?.content !== "string") {
      throw new APIError("invalid_ai_response", "The evaluator returned an unreadable response. Please try again.", 502);
    }

    const result = validateFeedbackJson(message.content);
    const modelTurn = { role: "assistant", content: message.content };
    return { result, history: [...history, userTurn, modelTurn] };
  }

  return {
    async initial() {
      const prompt = PROMPTS.initial.replace("EMOTIONS_PLACEHOLDER", sampleThreeEmotions());
      const reply = await generate([], prompt);
      if (reply.result.is_satisfied || reply.result.feedback[0] !== "Draw me a sheep.") {
        throw new APIError("invalid_ai_response", "The terminal could not prepare an instruction. Please try again.", 502);
      }
      return reply;
    },

    async evaluate({ history, vision, imageBase64, roundNumber }) {
      const stage = roundNumber < 3 ? "trial" : roundNumber === 3 ? "last_try" : "fail";
      const prompt = PROMPTS[stage].replace("SCENE_PLACEHOLDER", vision);
      return generate(history, [
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${imageBase64}`,
            detail: "high",
          },
        },
        { type: "text", text: prompt },
      ]);
    },
  };
}

export function validateStartRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new APIError("invalid_request", "The submission could not be read. Please try again.", 422);
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "email") {
    throw new APIError("invalid_request", "The submission could not be read. Please try again.", 422);
  }
  if (typeof body.email !== "string" || body.email.length < 1 || body.email.length > 254) {
    throw new APIError("invalid_request", "The submission could not be read. Please try again.", 422);
  }
  return { email: body.email };
}

export function validateDrawingSubmission(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new APIError("invalid_request", "The submission could not be read. Please try again.", 422);
  }
  const keys = Object.keys(body);
  if (
    keys.length !== 3 ||
    !keys.includes("submission_id") ||
    !keys.includes("round") ||
    !keys.includes("image_base64")
  ) {
    throw new APIError("invalid_request", "The submission could not be read. Please try again.", 422);
  }
  if (typeof body.submission_id !== "string" || !UUID_RE.test(body.submission_id)) {
    throw new APIError("invalid_request", "The submission could not be read. Please try again.", 422);
  }
  if (typeof body.round !== "number" || !Number.isInteger(body.round) || body.round < 1 || body.round > 4) {
    throw new APIError("invalid_request", "The submission could not be read. Please try again.", 422);
  }
  if (typeof body.image_base64 !== "string" || body.image_base64.length < 1 || body.image_base64.length > MAX_BASE64_LEN) {
    throw new APIError("invalid_request", "The submission could not be read. Please try again.", 422);
  }
  return {
    submission_id: body.submission_id.toLowerCase(),
    round: body.round,
    image_base64: body.image_base64,
  };
}

export function parseAllowedOrigins(raw) {
  if (!raw || typeof raw !== "string") return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

export function buildHeaders(origin, allowedOrigins) {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (origin) {
    const normalizedOrigin = origin.replace(/\/+$/, "");
    if (allowedOrigins.size === 0 || allowedOrigins.has(normalizedOrigin)) {
      headers["Access-Control-Allow-Origin"] = normalizedOrigin;
      headers["Access-Control-Allow-Methods"] = "POST, DELETE, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
      headers["Access-Control-Max-Age"] = "86400";
      headers.Vary = "Origin";
    }
  }
  return headers;
}

export class SessionController {
  constructor(storage, { clock = () => Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
    this.storage = storage;
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.locked = false;
  }

  async init({ vision, history, email, modelId, ownerToken }) {
    const now = this.clock();
    const session = {
      vision,
      history,
      lastActivity: now,
      email,
      modelId,
      ownerToken,
      round: 1,
      finished: false,
      results: {},
    };
    await this.storage.put("session", session);
    await this.storage.setAlarm(now + this.ttlMs);
    return { ok: true };
  }

  async _loadActiveSession(ownerToken) {
    const session = await this.storage.get("session");
    if (!session) {
      throw new APIError("session_expired", "This session has expired. Please start again.", 410);
    }
    const now = this.clock();
    if (!this.locked && now - session.lastActivity >= this.ttlMs) {
      await this.storage.deleteAll();
      await this.storage.deleteAlarm();
      throw new APIError("session_expired", "This session has expired. Please start again.", 410);
    }
    if (!ownerToken || !timingSafeEqual(ownerToken, session.ownerToken)) {
      throw new APIError("unauthorized_session", "Session access denied.", 403);
    }
    return session;
  }

  async submit({ ownerToken, body, ai }) {
    const session = await this._loadActiveSession(ownerToken);
    const parsed = validateDrawingSubmission(body);
    validatePngBase64(parsed.image_base64);

    const fingerprint = `${parsed.round}:${await sha256Hex(parsed.image_base64)}`;
    const existing = session.results[parsed.submission_id];
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new APIError("submission_conflict", "This submission has changed. Please start a new submission.", 409);
      }
      session.lastActivity = this.clock();
      await this.storage.put("session", session);
      await this.storage.setAlarm(session.lastActivity + this.ttlMs);
      return existing.response;
    }

    if (this.locked) {
      throw new APIError("session_busy", "The evaluator is still reading your drawing. Please wait, then retry.", 409);
    }
    if (session.finished) {
      throw new APIError("session_closed", "This session is complete. Start again for a new instruction.", 409);
    }
    if (parsed.round !== session.round) {
      throw new APIError("round_conflict", "This drawing belongs to an earlier attempt. Please start again.", 409);
    }

    this.locked = true;
    session.lastActivity = this.clock();
    let reply;
    try {
      reply = await ai.evaluate({
        history: session.history,
        vision: session.vision,
        imageBase64: parsed.image_base64,
        roundNumber: session.round,
      });
    } finally {
      this.locked = false;
      session.lastActivity = this.clock();
    }

    const satisfied = reply.result.is_satisfied;
    const state = satisfied ? "accepted" : session.round === 4 ? "terminated" : "retry";
    const feedback = [...reply.result.feedback];
    if (state === "retry" && session.round === 3) {
      feedback[feedback.length - 1] = "This is your last try.";
    }
    const response = {
      round: session.round,
      next_round: state === "retry" ? session.round + 1 : null,
      state,
      feedback,
    };

    session.history = reply.history;
    session.results[parsed.submission_id] = { fingerprint, response };
    session.finished = state !== "retry";
    if (!session.finished) {
      session.round += 1;
    }
    await this.storage.put("session", session);
    await this.storage.setAlarm(session.lastActivity + this.ttlMs);
    return response;
  }

  async remove({ ownerToken }) {
    const session = await this.storage.get("session");
    if (!session) return;
    if (!ownerToken || !timingSafeEqual(ownerToken, session.ownerToken)) {
      throw new APIError("unauthorized_session", "Session access denied.", 403);
    }
    if (this.locked) {
      throw new APIError("session_busy", "The evaluator is still working. Please wait, then retry.", 409);
    }
    await this.storage.deleteAll();
    await this.storage.deleteAlarm();
  }
}
