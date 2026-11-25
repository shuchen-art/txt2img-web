"""Single-process, memory-only web terminal. Run with `python run.py`."""

import asyncio
import base64
import binascii
from contextlib import asynccontextmanager, suppress
import csv
from dataclasses import dataclass, field
import hashlib
from io import BytesIO
import logging
import os
from pathlib import Path
import secrets
import time
from typing import Literal
from uuid import UUID

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field

from ai_service import AIError, DeepSeekAI, UnavailableAI

ROOT = Path(__file__).resolve().parent
MAX_PNG_BYTES = 2 * 1024 * 1024
MAX_BODY_BYTES = 3 * 1024 * 1024
SESSION_TTL = 30 * 60
AI_TIMEOUT = 45
AUTH_COOKIE = "txt2img_auth"
logger = logging.getLogger(__name__)


class APIError(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.message, self.status = code, message, status


def normalize_email(email: str) -> str:
    return email.strip().lower()


def derive_human_id(normalized_email: str) -> str:
    digest = hashlib.sha256(normalized_email.encode("utf-8")).digest()
    number = 10000 + (int.from_bytes(digest[:4], "big") % 90000)
    return f"Human #{number}"


class Allowlist:
    def resolve(self, email: str) -> str | None:
        raise NotImplementedError


class StaticAllowlist(Allowlist):
    def __init__(self, entries: dict[str, str]):
        self.entries: dict[str, str] = {}
        for email, human_id in entries.items():
            normalized = normalize_email(email)
            if not normalized:
                continue
            cleaned_id = human_id.strip() if human_id else ""
            self.entries[normalized] = cleaned_id or derive_human_id(normalized)

    def resolve(self, email: str) -> str | None:
        return self.entries.get(normalize_email(email))


class FileAllowlist(Allowlist):
    """Local CSV allowlist (`email,human_id`) with automatic mtime hot-reload."""

    def __init__(self, path: Path):
        self.path = path
        self._signature: tuple[int, int] | None = None
        self._entries: dict[str, str] = {}

    def _reload_if_changed(self) -> None:
        try:
            stat = self.path.stat()
        except OSError:
            self._signature = None
            self._entries = {}
            return
        signature = (stat.st_mtime_ns, stat.st_size)
        if signature == self._signature:
            return
        entries: dict[str, str] = {}
        try:
            with self.path.open("r", encoding="utf-8", newline="") as handle:
                for row in csv.reader(handle):
                    if not row:
                        continue
                    raw_email = row[0].strip()
                    if not raw_email or raw_email.startswith("#"):
                        continue
                    lowered = raw_email.lower()
                    if lowered == "email" and (len(row) < 2 or row[1].strip().lower() in ("", "human_id", "model_id")):
                        continue
                    raw_id = row[1].strip() if len(row) > 1 else ""
                    entries[lowered] = raw_id or derive_human_id(lowered)
        except OSError:
            entries = {}
        self._signature = signature
        self._entries = entries

    def resolve(self, email: str) -> str | None:
        self._reload_if_changed()
        return self._entries.get(normalize_email(email))


class StartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=1, max_length=254)


class DrawingSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    submission_id: UUID
    round: int = Field(ge=1, le=4, strict=True)
    image_base64: str = Field(min_length=1, max_length=(MAX_PNG_BYTES + 2) // 3 * 4)


class StartResponse(BaseModel):
    session_id: str
    model_id: str
    owner_token: str
    round: int = 1
    instructions: list[str]


class VerdictResponse(BaseModel):
    round: int
    next_round: int | None
    state: Literal["retry", "accepted", "terminated"]
    feedback: list[str]


@dataclass
class Session:
    vision: str
    history: tuple
    last_activity: float
    email: str
    model_id: str
    owner_token: str
    round: int = 1
    finished: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    results: dict = field(default_factory=dict)


def decode_drawing(encoded: str) -> bytes:
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise APIError("invalid_image", "Submit a valid PNG drawing.") from None
    if len(data) > MAX_PNG_BYTES:
        raise APIError("image_too_large", "The drawing is too large to submit.", 413)
    try:
        with Image.open(BytesIO(data)) as source:
            if source.format != "PNG" or source.is_animated:
                raise APIError("invalid_image", "Submit a single PNG drawing.")
            if min(source.size) < 16 or max(source.size) > 2048:
                raise APIError("invalid_dimensions", "The drawing dimensions are not supported.")
            source.verify()
        with Image.open(BytesIO(data)) as source:
            rgba = source.convert("RGBA")
            background = Image.new("RGBA", rgba.size, "white")
            image = Image.alpha_composite(background, rgba).convert("RGB")
        if image.convert("L").getextrema()[0] >= 245:
            raise APIError("blank_drawing", "Make a mark before submitting.")
        output = BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()
    except APIError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        raise APIError("invalid_image", "The drawing could not be read. Please try again.") from None


class LimitBodyMiddleware:
    """Bound input before JSON decoding, including requests with no Content-Length."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        chunks, total = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            total += len(message.get("body", b""))
            if total > MAX_BODY_BYTES:
                response = JSONResponse({"error": {"code": "request_too_large", "message": "The drawing is too large to submit."}}, status_code=413)
                return await response(scope, receive, send)
            chunks.append(message)
            if not message.get("more_body", False):
                break

        async def replay():
            return chunks.pop(0) if chunks else await receive()
        await self.app(scope, replay, send)


def create_app(engine=None, *, clock=time.monotonic, ttl=SESSION_TTL, ai_timeout=AI_TIMEOUT, allowlist=None):
    sessions: dict[str, Session] = {}
    if engine is None or allowlist is None:
        load_dotenv(ROOT / ".env")
    if engine is None:
        key = os.getenv("DS_API_KEY", "").strip() or os.getenv("DEEPSEEK_API_KEY", "").strip()
        model = os.getenv("DEEPSEEK_MODEL", "").strip() or "deepseek-flash"
        engine = DeepSeekAI(key, model) if key else UnavailableAI()
    if allowlist is None:
        raw_path = os.getenv("ALLOWLIST_PATH", "").strip()
        allowlist_path = Path(raw_path) if raw_path else ROOT / "allowlist.csv"
        if not allowlist_path.is_absolute():
            allowlist_path = ROOT / allowlist_path
        gate: Allowlist = FileAllowlist(allowlist_path)
    elif isinstance(allowlist, Allowlist):
        gate = allowlist
    else:
        gate = StaticAllowlist(allowlist)

    def purge():
        now = clock()
        for sid, session in list(sessions.items()):
            if not session.lock.locked() and now - session.last_activity >= ttl:
                sessions.pop(sid, None)

    async def cleanup_loop():
        while True:
            await asyncio.sleep(60)
            purge()

    @asynccontextmanager
    async def lifespan(app):
        cleanup = asyncio.create_task(cleanup_loop())
        try:
            yield
        finally:
            cleanup.cancel()
            with suppress(asyncio.CancelledError):
                await cleanup
            sessions.clear()
            await engine.aclose()

    app = FastAPI(title="txt2img⁻¹-web", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(LimitBodyMiddleware)

    @app.middleware("http")
    async def headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        return response

    async def error_response(request, exc):
        return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status)

    app.add_exception_handler(APIError, error_response)
    app.add_exception_handler(AIError, error_response)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        return JSONResponse({"error": {"code": "invalid_request", "message": "The submission could not be read. Please try again."}}, status_code=422)

    async def call_ai(awaitable):
        try:
            async with asyncio.timeout(ai_timeout):
                return await awaitable
        except TimeoutError:
            raise APIError("ai_timeout", "The evaluator took too long. Please try again; this attempt was not counted.", 504) from None

    def extract_owner_token(request: Request) -> str | None:
        auth = request.headers.get("authorization", "").strip()
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
            if token:
                return token
        return request.cookies.get(AUTH_COOKIE)

    def get_session(sid: str, request: Request) -> Session:
        purge()
        if sid not in sessions:
            raise APIError("session_expired", "This session has expired. Please start again.", 410)
        session = sessions[sid]
        token = extract_owner_token(request)
        if not token or not secrets.compare_digest(token, session.owner_token):
            raise APIError("unauthorized_session", "Session access denied.", 403)
        return session

    @app.post("/api/sessions", response_model=StartResponse, status_code=201)
    async def start(body: StartRequest, request: Request, response: Response):
        purge()
        normalized = normalize_email(body.email)
        model_id = gate.resolve(normalized)
        if not model_id:
            raise APIError("email_not_allowed", "Access denied. This email is not on the allowlist.", 403)
        reply = await call_ai(engine.initial())
        existing_token = extract_owner_token(request)
        token = existing_token if existing_token else secrets.token_urlsafe(32)
        sid = secrets.token_urlsafe(32)
        sessions[sid] = Session(
            vision=reply.result.detail,
            history=reply.history,
            last_activity=clock(),
            email=normalized,
            model_id=model_id,
            owner_token=token,
        )
        if request.cookies.get(AUTH_COOKIE) != token:
            response.set_cookie(
                key=AUTH_COOKIE,
                value=token,
                httponly=True,
                samesite="strict",
                path="/api",
            )
        return StartResponse(session_id=sid, model_id=model_id, owner_token=token, instructions=reply.result.feedback)

    @app.post("/api/sessions/{sid}/drawings", response_model=VerdictResponse)
    async def submit(sid: str, body: DrawingSubmission, request: Request):
        session = get_session(sid, request)
        image = decode_drawing(body.image_base64)
        fingerprint = (body.round, hashlib.sha256(image).hexdigest())
        submission_id = str(body.submission_id)
        if submission_id in session.results:
            previous_fingerprint, response = session.results[submission_id]
            if previous_fingerprint != fingerprint:
                raise APIError("submission_conflict", "This submission has changed. Please start a new submission.", 409)
            session.last_activity = clock()
            return response
        if session.lock.locked():
            raise APIError("session_busy", "The evaluator is still reading your drawing. Please wait, then retry.", 409)
        async with session.lock:
            if session.finished:
                raise APIError("session_closed", "This session is complete. Start again for a new instruction.", 409)
            if body.round != session.round:
                raise APIError("round_conflict", "This drawing belongs to an earlier attempt. Please start again.", 409)
            session.last_activity = clock()
            try:
                reply = await call_ai(engine.evaluate(
                    history=session.history, vision=session.vision, image=image, round_number=session.round,
                ))
            finally:
                session.last_activity = clock()
            satisfied = reply.result.is_satisfied
            state = "accepted" if satisfied else "terminated" if session.round == 4 else "retry"
            feedback = list(reply.result.feedback)
            if state == "retry" and session.round == 3:
                feedback[-1] = "This is your last try."
            response = VerdictResponse(round=session.round, next_round=session.round + 1 if state == "retry" else None,
                                       state=state, feedback=feedback)
            # Commit only after a complete, validated response. Failures leave history and round untouched.
            session.history = reply.history
            session.results[submission_id] = (fingerprint, response)
            session.finished = state != "retry"
            if not session.finished:
                session.round += 1
            return response

    @app.delete("/api/sessions/{sid}", status_code=204)
    async def delete(sid: str, request: Request):
        session = sessions.get(sid)
        if session:
            token = extract_owner_token(request)
            if not token or not secrets.compare_digest(token, session.owner_token):
                raise APIError("unauthorized_session", "Session access denied.", 403)
            if session.lock.locked():
                raise APIError("session_busy", "The evaluator is still working. Please wait, then retry.", 409)
        sessions.pop(sid, None)
        return Response(status_code=204)

    @app.get("/", include_in_schema=False)
    async def index():
        return FileResponse(ROOT / "static" / "index.html")

    app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
    app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="root_static")
    return app
