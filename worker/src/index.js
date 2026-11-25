import { DurableObject } from "cloudflare:workers";
import {
  APIError,
  MAX_BODY_BYTES,
  SessionController,
  buildHeaders,
  createDeepSeekClient,
  normalizeEmail,
  parseAllowedOrigins,
  randomToken,
  resolveAllowlistEmail,
  validateStartRequest,
} from "./core.js";

function jsonResponse(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function extractBearerToken(request) {
  const auth = (request.headers.get("Authorization") || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return "";
}

async function readJsonLimited(request) {
  const rawLen = request.headers.get("Content-Length");
  if (rawLen && Number(rawLen) > MAX_BODY_BYTES) {
    throw new APIError("request_too_large", "The drawing is too large to submit.", 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new APIError("request_too_large", "The drawing is too large to submit.", 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new APIError("invalid_request", "The submission could not be read. Please try again.", 422);
  }
}

export class DrawingSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.controller = new SessionController(ctx.storage);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/init" && request.method === "POST") {
        const data = await request.json();
        await this.controller.init(data);
        return jsonResponse({ ok: true }, 200, {});
      }
      if (url.pathname === "/submit" && request.method === "POST") {
        const { ownerToken, body } = await request.json();
        const ai = createDeepSeekClient({
          apiKey: this.env.DS_API_KEY || this.env.DEEPSEEK_API_KEY,
          model: this.env.DEEPSEEK_MODEL,
        });
        const result = await this.controller.submit({ ownerToken, body, ai });
        return jsonResponse(result, 200, {});
      }
      if (url.pathname === "/remove" && request.method === "DELETE") {
        const ownerToken = extractBearerToken(request);
        await this.controller.remove({ ownerToken });
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: { code: "not_found", message: "Not found." } }, 404, {});
    } catch (error) {
      if (error instanceof APIError) {
        return jsonResponse({ error: { code: error.code, message: error.message } }, error.status, {});
      }
      return jsonResponse(
        { error: { code: "internal_error", message: "Unexpected error. Please try again." } },
        500,
        {},
      );
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const headers = buildHeaders(origin, allowedOrigins);

    if (origin && allowedOrigins.size > 0 && !allowedOrigins.has(origin.replace(/\/+$/, ""))) {
      return jsonResponse(
        { error: { code: "origin_not_allowed", message: "Origin not allowed." } },
        403,
        headers,
      );
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    try {
      if (url.pathname === "/api/sessions" && request.method === "POST") {
        const rawBody = await readJsonLimited(request);
        const { email } = validateStartRequest(rawBody);
        const normalized = normalizeEmail(email);
        const modelId = await resolveAllowlistEmail(env.ALLOWLIST, normalized);
        if (!modelId) {
          throw new APIError("email_not_allowed", "Access denied. This email is not on the allowlist.", 403);
        }

        const ai = createDeepSeekClient({
          apiKey: env.DS_API_KEY || env.DEEPSEEK_API_KEY,
          model: env.DEEPSEEK_MODEL,
        });
        const reply = await ai.initial();

        const sid = randomToken();
        const ownerToken = extractBearerToken(request) || randomToken();
        const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sid));
        const initRes = await stub.fetch("https://do/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vision: reply.result.detail,
            history: reply.history,
            email: normalized,
            modelId,
            ownerToken,
          }),
        });
        if (!initRes.ok) {
          throw new APIError("session_init_failed", "Could not start session. Please try again.", 500);
        }

        return jsonResponse(
          {
            session_id: sid,
            model_id: modelId,
            owner_token: ownerToken,
            round: 1,
            instructions: reply.result.feedback,
          },
          201,
          headers,
        );
      }

      const drawMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/drawings$/);
      if (drawMatch && request.method === "POST") {
        const sid = decodeURIComponent(drawMatch[1]);
        const body = await readJsonLimited(request);
        const ownerToken = extractBearerToken(request);
        const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sid));
        const doRes = await stub.fetch("https://do/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ownerToken, body }),
        });
        const text = await doRes.text();
        return new Response(text, {
          status: doRes.status,
          headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
        });
      }

      const delMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (delMatch && request.method === "DELETE") {
        const sid = decodeURIComponent(delMatch[1]);
        const ownerToken = extractBearerToken(request);
        const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sid));
        const doRes = await stub.fetch("https://do/remove", {
          method: "DELETE",
          headers: ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {},
        });
        if (doRes.status === 204) {
          return new Response(null, { status: 204, headers });
        }
        const text = await doRes.text();
        return new Response(text, {
          status: doRes.status,
          headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
        });
      }

      return jsonResponse({ error: { code: "not_found", message: "Not found." } }, 404, headers);
    } catch (error) {
      if (error instanceof APIError) {
        return jsonResponse({ error: { code: error.code, message: error.message } }, error.status, headers);
      }
      return jsonResponse(
        { error: { code: "invalid_request", message: "The submission could not be read. Please try again." } },
        400,
        headers,
      );
    }
  },
};
