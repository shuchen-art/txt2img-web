import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  APIError,
  MAX_PNG_BYTES,
  SESSION_TTL_MS,
  SessionController,
  buildHeaders,
  createDeepSeekClient,
  deriveHumanId,
  parseAllowedOrigins,
  resolveAllowlistEmail,
  validatePngBase64,
} from "../src/core.js";
import { PROMPTS } from "../src/prompts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

function makePngBytes({ width = 64, height = 48, animated = false, truncated = false } = {}) {
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // RGB

  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length, false);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    return out;
  }

  const parts = [sig, chunk("IHDR", ihdrData)];
  if (animated) parts.push(chunk("acTL", new Uint8Array(8)));
  parts.push(chunk("IDAT", new Uint8Array([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])));
  if (!truncated) parts.push(chunk("IEND", new Uint8Array(0)));

  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const full = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    full.set(p, offset);
    offset += p.length;
  }
  return Buffer.from(full).toString("base64");
}

function makeMemoryStorage() {
  const map = new Map();
  let alarm = null;
  return {
    async get(k) {
      return map.get(k);
    },
    async put(k, v) {
      map.set(k, structuredClone(v));
    },
    async deleteAll() {
      map.clear();
    },
    async setAlarm(ts) {
      alarm = ts;
    },
    async deleteAlarm() {
      alarm = null;
    },
    get alarm() {
      return alarm;
    },
    get size() {
      return map.size;
    },
  };
}

function makeFakeAI(verdicts = [false, false, false, false]) {
  let gate = null;
  let enteredResolve = null;
  const calls = [];
  return {
    calls,
    failNext: false,
    setGate() {
      let release;
      gate = new Promise((r) => {
        release = r;
      });
      return release;
    },
    waitEntered() {
      return new Promise((r) => {
        enteredResolve = r;
      });
    },
    async initial() {
      return {
        result: {
          detail: "PRIVATE VISION",
          is_satisfied: false,
          feedback: ["Draw me a sheep.", "Draw a tall line.", "Make the body angular."],
        },
        history: ["PRIVATE VISION"],
      };
    },
    async evaluate({ history, vision, imageBase64, roundNumber }) {
      calls.push({ history, vision, imageBase64, roundNumber });
      if (enteredResolve) {
        enteredResolve();
        enteredResolve = null;
      }
      if (gate) {
        await gate;
        gate = null;
      }
      if (this.failNext) {
        this.failNext = false;
        throw new APIError("ai_unavailable", "Please retry.", 502);
      }
      const result = {
        detail: "accuracy: 2, aesthetic: 2",
        is_satisfied: Boolean(verdicts[roundNumber - 1]),
        feedback: ["You drew a soft shape.", "Use straight lines.", "Move the sheep lower."],
      };
      return { result, history: [...history, imageBase64, result] };
    },
  };
}

test("prompts.js matches prompts/*.txt verbatim", () => {
  for (const name of ["system", "initial", "trial", "last_try", "fail"]) {
    const disk = readFileSync(resolve(ROOT, `prompts/${name}.txt`), "utf8").trimEnd();
    assert.equal(PROMPTS[name], disk, `Prompt mismatch for ${name}`);
  }
});

test("allowlist supports CSV, single-line pairs, normalization, and deterministic IDs", async () => {
  const csv = [
    "email,human_id",
    "# ignored comment",
    "cleavcw@hkust-gz.edu.cn,Human #83791",
    "auto@example.com,",
  ].join("\n");

  assert.equal(await resolveAllowlistEmail(csv, "  CleaVCW@HKUST-GZ.EDU.CN "), "Human #83791");
  assert.equal(await resolveAllowlistEmail(csv, "outsider@example.com"), null);
  assert.equal(await resolveAllowlistEmail("", "cleavcw@hkust-gz.edu.cn"), null);

  const auto1 = await resolveAllowlistEmail(csv, "auto@example.com");
  const auto2 = await resolveAllowlistEmail(csv, "AUTO@EXAMPLE.COM");
  assert.equal(auto1, auto2);
  assert.match(auto1, /^Human #\d{5}$/);
  assert.equal(auto1, await deriveHumanId("auto@example.com"));

  const oneLine = "cleavcw@hkust-gz.edu.cn:Human #83791; second@example.com=Human #00002";
  assert.equal(await resolveAllowlistEmail(oneLine, "cleavcw@hkust-gz.edu.cn"), "Human #83791");
  assert.equal(await resolveAllowlistEmail(oneLine, "second@example.com"), "Human #00002");

  const commaEmails = "a@example.com, b@example.com";
  assert.equal(await resolveAllowlistEmail(commaEmails, "a@example.com"), await deriveHumanId("a@example.com"));
  assert.equal(await resolveAllowlistEmail(commaEmails, "b@example.com"), await deriveHumanId("b@example.com"));
});

test("PNG validation accepts valid 4:3 PNG and rejects invalid/animated/oversized inputs", () => {
  validatePngBase64(makePngBytes({ width: 1152, height: 864 }));

  assert.throws(() => validatePngBase64(""), { code: "invalid_image" });
  assert.throws(() => validatePngBase64("not base64!"), { code: "invalid_image" });
  assert.throws(() => validatePngBase64(Buffer.from("not a png").toString("base64")), { code: "invalid_image" });
  assert.throws(() => validatePngBase64(makePngBytes({ width: 8, height: 64 })), { code: "invalid_dimensions" });
  assert.throws(() => validatePngBase64(makePngBytes({ width: 2050, height: 64 })), { code: "invalid_dimensions" });
  assert.throws(() => validatePngBase64(makePngBytes({ animated: true })), { code: "invalid_image" });
  assert.throws(() => validatePngBase64(makePngBytes({ truncated: true })), { code: "invalid_image" });

  const huge = Buffer.alloc(MAX_PNG_BYTES + 1).toString("base64");
  assert.throws(() => validatePngBase64(huge), { code: "image_too_large", status: 413 });
});

test("SessionController covers all 4 rounds, round-3 last try, and closed session", async () => {
  const storage = makeMemoryStorage();
  let now = 1000;
  const ctrl = new SessionController(storage, { clock: () => now });
  const ai = makeFakeAI([false, false, false, false]);
  const ownerToken = "tok-owner";
  await ctrl.init({ vision: "V", history: ["V"], email: "a@b.com", modelId: "Human #83791", ownerToken });

  const img = makePngBytes();
  const r1 = await ctrl.submit({ ownerToken, body: { submission_id: "00000000-0000-4000-8000-000000000001", round: 1, image_base64: img }, ai });
  assert.equal(r1.state, "retry");
  assert.equal(r1.next_round, 2);

  const r2 = await ctrl.submit({ ownerToken, body: { submission_id: "00000000-0000-4000-8000-000000000002", round: 2, image_base64: img }, ai });
  assert.equal(r2.state, "retry");

  const r3 = await ctrl.submit({ ownerToken, body: { submission_id: "00000000-0000-4000-8000-000000000003", round: 3, image_base64: img }, ai });
  assert.equal(r3.state, "retry");
  assert.equal(r3.feedback[2], "This is your last try.");

  const r4 = await ctrl.submit({ ownerToken, body: { submission_id: "00000000-0000-4000-8000-000000000004", round: 4, image_base64: img }, ai });
  assert.equal(r4.state, "terminated");
  assert.equal(r4.next_round, null);

  await assert.rejects(
    ctrl.submit({ ownerToken, body: { submission_id: "00000000-0000-4000-8000-000000000005", round: 4, image_base64: img }, ai }),
    { code: "session_closed", status: 409 },
  );
});

test("SessionController enforces ownership, idempotent replay, concurrency lock, and TTL expiration", async () => {
  const storage = makeMemoryStorage();
  let now = 0;
  const ctrl = new SessionController(storage, { clock: () => now, ttlMs: SESSION_TTL_MS });
  const ai = makeFakeAI([false, true, false, false]);
  const ownerToken = "tok-owner";
  await ctrl.init({ vision: "V", history: ["V"], email: "a@b.com", modelId: "Human #83791", ownerToken });

  const img = makePngBytes();
  const sub1 = { submission_id: "00000000-0000-4000-8000-000000000011", round: 1, image_base64: img };

  await assert.rejects(ctrl.submit({ ownerToken: "wrong", body: sub1, ai }), { code: "unauthorized_session", status: 403 });
  await assert.rejects(ctrl.remove({ ownerToken: "wrong" }), { code: "unauthorized_session", status: 403 });

  // Concurrent lock test
  const release = ai.setGate();
  const entered = ai.waitEntered();
  const pending = ctrl.submit({ ownerToken, body: sub1, ai });
  await entered;
  await assert.rejects(ctrl.submit({ ownerToken, body: sub1, ai }), { code: "session_busy", status: 409 });
  await assert.rejects(ctrl.remove({ ownerToken }), { code: "session_busy", status: 409 });
  release();
  const first = await pending;
  assert.equal(first.state, "retry");

  // Replay returns cached response without calling AI again
  const replay = await ctrl.submit({ ownerToken, body: sub1, ai });
  assert.deepEqual(replay, first);
  assert.equal(ai.calls.length, 1);

  // Conflict when reusing same submission_id with different image
  await assert.rejects(
    ctrl.submit({ ownerToken, body: { ...sub1, image_base64: makePngBytes({ width: 80, height: 60 }) }, ai }),
    { code: "submission_conflict", status: 409 },
  );

  // Expiration test
  now += SESSION_TTL_MS + 1;
  await assert.rejects(
    ctrl.submit({ ownerToken, body: { submission_id: "00000000-0000-4000-8000-000000000012", round: 2, image_base64: img }, ai }),
    { code: "session_expired", status: 410 },
  );
  assert.equal(storage.size, 0);
});

test("DeepSeek client validates JSON and maps HTTP errors cleanly", async () => {
  const unconfigured = createDeepSeekClient({ apiKey: "" });
  await assert.rejects(unconfigured.initial(), { code: "ai_not_configured", status: 503 });

  const rateLimited = createDeepSeekClient({
    apiKey: "k",
    fetchImpl: async () => new Response("rate limit", { status: 429 }),
  });
  await assert.rejects(rateLimited.initial(), { code: "ai_busy", status: 503 });

  const badJson = createDeepSeekClient({
    apiKey: "k",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ detail: "x", is_satisfied: false, feedback: ["Wrong first line.", "b", "c"] }) } }],
        }),
        { status: 200 },
      ),
  });
  await assert.rejects(badJson.initial(), { code: "invalid_ai_response", status: 502 });
});

test("CORS header builder restricts browser origins when configured", () => {
  const allowed = parseAllowedOrigins("https://alice.github.io, https://example.com/");
  const okHeaders = buildHeaders("https://alice.github.io", allowed);
  assert.equal(okHeaders["Access-Control-Allow-Origin"], "https://alice.github.io");
  assert.match(okHeaders["Access-Control-Allow-Headers"], /Authorization/);

  const blockedHeaders = buildHeaders("https://evil.example", allowed);
  assert.equal(blockedHeaders["Access-Control-Allow-Origin"], undefined);
});
