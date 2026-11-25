import asyncio
import base64
from io import BytesIO
import os
from uuid import uuid4

import httpx
from PIL import Image, ImageDraw
import pytest

from ai_service import AIError, AIReply, Feedback, UnavailableAI
from app import create_app
import app as app_module

DEFAULT_EMAIL = "test@example.com"
DEFAULT_HUMAN_ID = "Human #83791"
DEFAULT_ALLOWLIST = {DEFAULT_EMAIL: DEFAULT_HUMAN_ID}


@pytest.fixture
def anyio_backend():
    return "asyncio"


class FakeAI:
    def __init__(self, verdicts=(False, False, False, False)):
        self.verdicts = verdicts
        self.starts = 0
        self.calls = []
        self.fail_next = False
        self.gate = None
        self.entered = asyncio.Event()

    async def initial(self):
        self.starts += 1
        vision = f"PRIVATE VISION {self.starts}"
        return AIReply(Feedback(detail=vision, is_satisfied=False,
                                feedback=["Draw me a sheep.", "Draw a tall line.", "Make the body angular."]), (vision,))

    async def evaluate(self, **kwargs):
        self.calls.append(kwargs)
        self.entered.set()
        if self.gate:
            await self.gate.wait()
        if self.fail_next:
            self.fail_next = False
            raise AIError("ai_unavailable", "Please retry.")
        number = kwargs["round_number"]
        result = Feedback(detail="accuracy: 2, aesthetic: 2", is_satisfied=self.verdicts[number - 1],
                          feedback=["You drew a soft shape.", "Use straight lines.", "Move the sheep lower."])
        return AIReply(result, (*kwargs["history"], kwargs["image"], result))

    async def aclose(self):
        pass


def png(*, ink=True, size=(64, 48), transparent=False, fmt="PNG"):
    image = Image.new("RGBA" if transparent else "RGB", size, (0, 0, 0, 0) if transparent else "white")
    if ink:
        ImageDraw.Draw(image).line((10, 10, 40, 30), fill="black", width=3)
    buffer = BytesIO()
    image.save(buffer, format=fmt)
    return base64.b64encode(buffer.getvalue()).decode()


def submission(round=1, **kwargs):
    return {"submission_id": str(uuid4()), "round": round, "image_base64": png(), **kwargs}


def client(engine=None, *, allowlist=DEFAULT_ALLOWLIST, **kwargs):
    app = create_app(engine or FakeAI(), allowlist=allowlist, **kwargs)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", trust_env=False)


async def start(c, email=DEFAULT_EMAIL):
    response = await c.post("/api/sessions", json={"email": email})
    assert response.status_code == 201
    assert "PRIVATE" not in response.text
    body = response.json()
    assert body["model_id"]
    return body["session_id"]


@pytest.mark.anyio
@pytest.mark.parametrize("accepted_round", [1, 2, 3, 4, None])
async def test_all_terminal_paths(accepted_round):
    engine = FakeAI(tuple(i == accepted_round for i in range(1, 5)))
    async with client(engine) as c:
        sid = await start(c)
        for number in range(1, (accepted_round or 4) + 1):
            response = await c.post(f"/api/sessions/{sid}/drawings", json=submission(number))
            assert response.status_code == 200
            result = response.json()
            assert result["round"] == number
            assert "PRIVATE" not in response.text and "accuracy" not in response.text
            if number == accepted_round:
                assert result["state"] == "accepted" and result["next_round"] is None
            elif number == 4:
                assert result["state"] == "terminated" and result["next_round"] is None
            else:
                assert result["state"] == "retry" and result["next_round"] == number + 1
                if number == 3:
                    assert result["feedback"][-1] == "This is your last try."
        response = await c.post(f"/api/sessions/{sid}/drawings", json=submission(min(accepted_round or 4, 4)))
        assert response.status_code == 409 and response.json()["error"]["code"] == "session_closed"


@pytest.mark.anyio
async def test_replay_is_idempotent_after_later_turn_and_after_completion():
    engine = FakeAI((False, True, False, False))
    async with client(engine) as c:
        sid = await start(c)
        url = f"/api/sessions/{sid}/drawings"
        first, second = submission(1), submission(2)
        result1 = await c.post(url, json=first)
        result2 = await c.post(url, json=second)
        assert (await c.post(url, json=first)).json() == result1.json()
        assert (await c.post(url, json=second)).json() == result2.json()
        assert len(engine.calls) == 2
        changed = {**first, "image_base64": png(size=(80, 60))}
        assert (await c.post(url, json=changed)).json()["error"]["code"] == "submission_conflict"


@pytest.mark.anyio
async def test_failure_retry_does_not_change_history_or_round():
    engine = FakeAI()
    async with client(engine) as c:
        sid = await start(c)
        body = submission()
        engine.fail_next = True
        assert (await c.post(f"/api/sessions/{sid}/drawings", json=body)).status_code == 502
        response = await c.post(f"/api/sessions/{sid}/drawings", json=body)
        assert response.json()["round"] == 1
        assert engine.calls[0]["history"] == engine.calls[1]["history"]
        assert engine.calls[0]["image"] == engine.calls[1]["image"]


@pytest.mark.anyio
async def test_concurrent_submission_and_delete_do_not_duplicate_evaluation():
    engine = FakeAI()
    engine.gate = asyncio.Event()
    async with client(engine) as c:
        sid = await start(c)
        url = f"/api/sessions/{sid}/drawings"
        body = submission()
        pending = asyncio.create_task(c.post(url, json=body))
        await engine.entered.wait()
        repeated = await c.post(url, json=body)
        other = await c.post(url, json=submission())
        deletion = await c.delete(f"/api/sessions/{sid}")
        assert all(r.status_code == 409 and r.json()["error"]["code"] == "session_busy" for r in (repeated, other, deletion))
        engine.gate.set()
        result = await pending
        assert (await c.post(url, json=body)).json() == result.json()
        assert len(engine.calls) == 1


@pytest.mark.anyio
async def test_session_isolation_delete_and_new_session():
    engine = FakeAI()
    async with client(engine) as c:
        a, b = await start(c), await start(c)
        await c.post(f"/api/sessions/{a}/drawings", json=submission())
        await c.post(f"/api/sessions/{b}/drawings", json=submission())
        assert engine.calls[0]["vision"] != engine.calls[1]["vision"]
        assert len(engine.calls[1]["history"]) == 1
        assert (await c.delete(f"/api/sessions/{a}")).status_code == 204
        assert (await c.post(f"/api/sessions/{a}/drawings", json=submission())).status_code == 410
        assert (await c.delete(f"/api/sessions/{a}")).status_code == 204
        fresh = await start(c)
        assert fresh not in (a, b)


@pytest.mark.anyio
async def test_expiration_and_activity_refresh():
    now = [0.0]
    async with client(clock=lambda: now[0], ttl=1800) as c:
        sid = await start(c)
        now[0] = 1700
        assert (await c.post(f"/api/sessions/{sid}/drawings", json=submission())).status_code == 200
        now[0] = 3400
        assert (await c.post(f"/api/sessions/{sid}/drawings", json=submission(2))).status_code == 200
        now[0] = 5201
        assert (await c.post(f"/api/sessions/{sid}/drawings", json=submission(3))).status_code == 410


@pytest.mark.anyio
async def test_timeout_unlocks_session_without_committing():
    engine = FakeAI()
    engine.gate = asyncio.Event()
    async with client(engine, ai_timeout=0.03) as c:
        sid = await start(c)
        body = submission()
        response = await c.post(f"/api/sessions/{sid}/drawings", json=body)
        assert response.status_code == 504
        engine.gate = None
        response = await c.post(f"/api/sessions/{sid}/drawings", json=body)
        assert response.status_code == 200 and response.json()["round"] == 1


@pytest.mark.anyio
@pytest.mark.parametrize("encoded", ["not base64", base64.b64encode(b"not a png").decode(),
                                    png(ink=False), png(ink=False, transparent=True), png(fmt="JPEG"),
                                    png(size=(8, 8)), png(size=(2050, 20))])
async def test_invalid_images_never_reach_ai(encoded):
    engine = FakeAI()
    async with client(engine) as c:
        sid = await start(c)
        response = await c.post(f"/api/sessions/{sid}/drawings", json=submission(image_base64=encoded))
        assert response.status_code == 400
        assert not engine.calls


@pytest.mark.anyio
async def test_round_order_request_size_and_validation():
    engine = FakeAI()
    async with client(engine) as c:
        sid = await start(c)
        url = f"/api/sessions/{sid}/drawings"
        assert (await c.post(url, json=submission(2))).json()["error"]["code"] == "round_conflict"
        assert (await c.post(url, json=submission(submission_id="invalid"))).status_code == 422
        assert (await c.post(url, json=submission(round=5))).status_code == 422
        assert (await c.post(url, content=b"x" * (3 * 1024 * 1024 + 1))).status_code == 413
        assert not engine.calls


@pytest.mark.anyio
async def test_email_allowlist_gating_normalization_and_model_id_binding():
    engine = FakeAI()
    async with client(engine, allowlist={"cleavcw@hkust-gz.edu.cn": "Human #83791"}) as c:
        assert (await c.post("/api/sessions")).status_code == 422
        denied = await c.post("/api/sessions", json={"email": "outsider@example.com"})
        assert denied.status_code == 403 and denied.json()["error"]["code"] == "email_not_allowed"
        assert engine.starts == 0

        first = await c.post("/api/sessions", json={"email": "  CleaVCW@HKUST-GZ.EDU.CN  "})
        assert first.status_code == 201
        assert first.json()["model_id"] == "Human #83791"

        second = await c.post("/api/sessions", json={"email": "cleavcw@hkust-gz.edu.cn"})
        assert second.status_code == 201
        assert second.json()["model_id"] == "Human #83791"
        assert engine.starts == 2


@pytest.mark.anyio
async def test_file_allowlist_hot_reload_and_deterministic_id(tmp_path, monkeypatch):
    allowlist_file = tmp_path / "allowlist.csv"
    monkeypatch.setenv("ALLOWLIST_PATH", str(allowlist_file))
    engine = FakeAI()
    app = create_app(engine)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", trust_env=False) as c:
            # Missing allowlist denies cleanly.
            assert (await c.post("/api/sessions", json={"email": "cleavcw@hkust-gz.edu.cn"})).status_code == 403

            allowlist_file.write_text(
                "email,human_id\n"
                "# comment row\n"
                "cleavcw@hkust-gz.edu.cn,Human #83791\n"
                "auto@example.com,\n",
                encoding="utf-8",
            )
            explicit = await c.post("/api/sessions", json={"email": "cleavcw@hkust-gz.edu.cn"})
            assert explicit.status_code == 201 and explicit.json()["model_id"] == "Human #83791"

            auto1 = await c.post("/api/sessions", json={"email": "auto@example.com"})
            auto2 = await c.post("/api/sessions", json={"email": "AUTO@EXAMPLE.COM"})
            assert auto1.status_code == 201 and auto2.status_code == 201
            assert auto1.json()["model_id"] == auto2.json()["model_id"]
            assert auto1.json()["model_id"].startswith("Human #")

            # Hot-reload after editing CSV without recreating app.
            allowlist_file.write_text("email,human_id\ncleavcw@hkust-gz.edu.cn,Human #99999\n", encoding="utf-8")
            stat = allowlist_file.stat()
            os.utime(allowlist_file, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
            updated = await c.post("/api/sessions", json={"email": "cleavcw@hkust-gz.edu.cn"})
            assert updated.status_code == 201 and updated.json()["model_id"] == "Human #99999"
            assert (await c.post("/api/sessions", json={"email": "auto@example.com"})).status_code == 403


@pytest.mark.anyio
async def test_session_ownership_enforced_across_clients():
    engine = FakeAI()
    app = create_app(engine, allowlist=DEFAULT_ALLOWLIST)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test", trust_env=False) as owner, \
                httpx.AsyncClient(transport=transport, base_url="http://test", trust_env=False) as intruder:
            sid = await start(owner)
            bad_submit = await intruder.post(f"/api/sessions/{sid}/drawings", json=submission())
            assert bad_submit.status_code == 403 and bad_submit.json()["error"]["code"] == "unauthorized_session"
            bad_delete = await intruder.delete(f"/api/sessions/{sid}")
            assert bad_delete.status_code == 403 and bad_delete.json()["error"]["code"] == "unauthorized_session"
            assert (await owner.post(f"/api/sessions/{sid}/drawings", json=submission())).status_code == 200
            assert (await owner.delete(f"/api/sessions/{sid}")).status_code == 204


@pytest.mark.anyio
async def test_bearer_token_auth_without_cookies():
    engine = FakeAI()
    app = create_app(engine, allowlist=DEFAULT_ALLOWLIST)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test", trust_env=False) as starter, \
                httpx.AsyncClient(transport=transport, base_url="http://test", trust_env=False) as bearer_client:
            started = await starter.post("/api/sessions", json={"email": DEFAULT_EMAIL})
            assert started.status_code == 201
            sid = started.json()["session_id"]
            token = started.json()["owner_token"]
            assert token
            wrong = await bearer_client.post(
                f"/api/sessions/{sid}/drawings",
                json=submission(),
                headers={"Authorization": "Bearer wrong-token"},
            )
            assert wrong.status_code == 403
            ok = await bearer_client.post(
                f"/api/sessions/{sid}/drawings",
                json=submission(),
                headers={"Authorization": f"Bearer {token}"},
            )
            assert ok.status_code == 200
            deleted = await bearer_client.delete(
                f"/api/sessions/{sid}",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert deleted.status_code == 204


@pytest.mark.anyio
async def test_static_page_and_missing_key_are_explicit():
    async with client(UnavailableAI()) as c:
        page = await c.get("/")
        assert page.status_code == 200 and '<title>txt2img⁻¹-web</title>' in page.text
        assert 'id="record"' in page.text and 'width="1152" height="864"' in page.text
        assert 'id="email"' in page.text and 'UNVERIFIED' in page.text
        for removed in ("SESSION LOG", "SESSION_REF", "ARCHIVE_STATE", "SAVE PNG", "END OF RECEIPT"):
            assert removed not in page.text
        assert "The machine imagines." not in page.text
        for asset in ("logo.svg", "fonts/PTMono-Regular.ttf", "fonts/OFL.txt", "config.js", "style.css", "app.js"):
            assert (await c.get(f"/static/{asset}")).status_code == 200
            assert (await c.get(f"/{asset}")).status_code == 200
        assert (await c.get("/static/../.env")).status_code == 404
        assert (await c.get("/../.env")).status_code == 404
        error = await c.post("/api/sessions", json={"email": DEFAULT_EMAIL})
        assert error.status_code == 503 and error.json()["error"]["code"] == "ai_not_configured"
        assert "API_KEY" not in error.text


@pytest.mark.anyio
@pytest.mark.parametrize("ds_key,standard_key,model,expected_key,expected_model", [
    ("ds-test", "", "", "ds-test", "deepseek-flash"),
    ("", "standard-test", "deepseek-flash", "standard-test", "deepseek-flash"),
    ("ds-test", "standard-test", "custom-vision", "ds-test", "custom-vision"),
    (" ", "standard-test", " ", "standard-test", "deepseek-flash"),
    ("", "", "", None, None),
])
async def test_deepseek_environment_configuration(tmp_path, monkeypatch, ds_key, standard_key, model, expected_key, expected_model):
    allowlist_file = tmp_path / "allowlist.csv"
    allowlist_file.write_text("email,human_id\nenv@example.com,Human #83791\n", encoding="utf-8")
    monkeypatch.setattr(app_module, "load_dotenv", lambda path: None)
    monkeypatch.setenv("DS_API_KEY", ds_key)
    monkeypatch.setenv("DEEPSEEK_API_KEY", standard_key)
    monkeypatch.setenv("DEEPSEEK_MODEL", model)
    monkeypatch.setenv("ALLOWLIST_PATH", str(allowlist_file))
    monkeypatch.setenv("GOOGLE_API_KEY", "old-provider-key-must-not-be-used")
    constructed = []
    def factory(key, selected_model):
        constructed.append((key, selected_model))
        return FakeAI()
    monkeypatch.setattr(app_module, "DeepSeekAI", factory)
    app = create_app()
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", trust_env=False) as c:
            response = await c.post("/api/sessions", json={"email": "env@example.com"})
            assert response.status_code == (201 if expected_key else 503)
    assert constructed == ([(expected_key, expected_model)] if expected_key else [])
