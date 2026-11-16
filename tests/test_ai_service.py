import asyncio
import base64
import json

import httpx
import pytest

from ai_service import AIError, DeepSeekAI


def result(satisfied=False, initial=False):
    return {"detail": "PRIVATE SCENE" if initial else "accuracy: 2, aesthetic: 2", "is_satisfied": satisfied,
            "feedback": ["Draw me a sheep." if initial else "You drew a curved form.", "Raise the line.", "Move the sheep lower."]}


def completion(data, *, finish_reason="stop", **message_fields):
    return {"choices": [{"message": {"role": "assistant", "content": json.dumps(data), **message_fields},
                         "finish_reason": finish_reason}]}


def test_client_accepts_loopback_no_proxy(monkeypatch):
    for name in ("NO_PROXY", "no_proxy"):
        monkeypatch.setenv(name, "localhost,127.0.0.1,::1,::1/128")
    async def run():
        engine = DeepSeekAI("test-only", "deepseek-flash")
        await engine.aclose()
    asyncio.run(run())


def test_deepseek_image_payload_history_stages_and_placeholder():
    async def run():
        requests = []

        def transport(request):
            assert str(request.url) == "https://api.deepseek.com/chat/completions"
            assert request.method == "POST"
            assert request.headers["Authorization"] == "Bearer test-only"
            body = json.loads(request.content)
            requests.append(body)
            assert body["model"] == "deepseek-flash"
            assert body["response_format"] == {"type": "json_object"}
            assert body["thinking"] == {"type": "disabled"}
            return httpx.Response(200, json=completion(result(initial=len(requests) == 1)))

        engine = DeepSeekAI("test-only", "deepseek-flash", transport=httpx.MockTransport(transport))
        try:
            reply = await engine.initial()
            assert "EMOTIONS_PLACEHOLDER" not in requests[0]["messages"][-1]["content"]
            assert len(reply.history) == 2
            image = b"test-png-bytes"
            for number in (1, 2, 3, 4):
                reply = await engine.evaluate(history=reply.history, vision="PRIVATE SCENE", image=image, round_number=number)
            assert [len(body["messages"]) for body in requests] == [2, 4, 6, 8, 10]
            assert all(body["messages"][0]["role"] == "system" for body in requests)
            wire_image = requests[1]["messages"][-1]["content"][0]
            assert wire_image == {"type": "image_url", "image_url": {
                "url": "data:image/png;base64," + base64.b64encode(image).decode(), "detail": "high"}}
            assert requests[2]["messages"][3]["content"][0] == wire_image
            assert requests[1]["messages"][2]["content"] == requests[2]["messages"][2]["content"]
            prompts = [body["messages"][-1]["content"][-1]["text"] for body in requests[1:]]
            assert all("both scores are < 4" in text for text in prompts[:3])
            assert "third submission" in prompts[2] and "This is your last try." in prompts[2]
            assert "both scores are < 3" in prompts[3] and "fourth and final" in prompts[3]
            assert all("SCENE_PLACEHOLDER" not in text for text in prompts)
        finally:
            await engine.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("payload", [
    completion({"detail": "secret", "is_satisfied": "false", "feedback": ["x"]}),
    completion({"detail": "secret", "is_satisfied": False, "feedback": ["", "x", "y"]}),
    completion({"detail": "secret", "is_satisfied": False, "feedback": ["wrong start", "x", "y"]}),
    completion(result(initial=True), finish_reason="length"),
    completion(result(initial=True), refusal="blocked"),
    {"choices": [{"finish_reason": "stop", "message": {"content": "   "}}]},
    {"choices": []},
])
def test_invalid_provider_output_is_a_technical_error(payload):
    async def run():
        engine = DeepSeekAI("test-only", "deepseek-flash", transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=payload)))
        try:
            with pytest.raises(AIError) as captured:
                await engine.initial()
            assert captured.value.code == "invalid_ai_response"
            assert "secret" not in captured.value.message
        finally:
            await engine.aclose()
    asyncio.run(run())


@pytest.mark.parametrize("http_status,expected_status,code", [
    (401, 503, "ai_not_available"), (402, 503, "ai_not_available"), (403, 503, "ai_not_available"),
    (429, 503, "ai_busy"), (500, 502, "ai_unavailable"),
])
def test_provider_errors_do_not_leak_or_retry(http_status, expected_status, code, caplog):
    async def run():
        calls = []
        def transport(request):
            calls.append(request)
            return httpx.Response(http_status, json={"error": {"message": "PRIVATE DETAILS test-only-key"}})
        engine = DeepSeekAI("test-only-key", "deepseek-flash", transport=httpx.MockTransport(transport))
        try:
            with pytest.raises(AIError) as captured:
                await engine.initial()
            assert captured.value.status == expected_status and captured.value.code == code
            assert "PRIVATE DETAILS" not in captured.value.message + caplog.text
            assert "test-only-key" not in captured.value.message + caplog.text
            assert len(calls) == 1
        finally:
            await engine.aclose()
    asyncio.run(run())


def test_timeout_can_be_retried_without_changing_history():
    async def run():
        bodies = []
        def transport(request):
            bodies.append(json.loads(request.content))
            if len(bodies) == 2:
                raise httpx.ReadTimeout("PRIVATE DETAILS", request=request)
            return httpx.Response(200, json=completion(result(initial=len(bodies) == 1)))
        engine = DeepSeekAI("test-only", "deepseek-flash", transport=httpx.MockTransport(transport))
        try:
            initial = await engine.initial()
            args = dict(history=initial.history, vision=initial.result.detail, image=b"png", round_number=1)
            with pytest.raises(AIError) as captured:
                await engine.evaluate(**args)
            assert captured.value.code == "ai_timeout" and captured.value.status == 504
            reply = await engine.evaluate(**args)
            assert bodies[1] == bodies[2]
            assert len(initial.history) == 2 and len(reply.history) == 4
        finally:
            await engine.aclose()
    asyncio.run(run())
