"""DeepSeek vision adapter. Only committed turns enter subsequent requests."""

import base64
from dataclasses import dataclass
import logging
import os
from pathlib import Path
import random
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

PROMPTS = Path(__file__).resolve().parent / "prompts"
EMOTIONS = (
    "admiration", "anger", "awe", "boredom", "calmness", "confusion",
    "disgust", "excitement", "fear", "joy", "sadness", "surprise",
)
logger = logging.getLogger(__name__)


class AIError(Exception):
    def __init__(self, code: str, message: str, status: int = 502):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class Feedback(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    detail: str = Field(min_length=1, max_length=4000)
    is_satisfied: bool
    feedback: list[str] = Field(min_length=3, max_length=3)


@dataclass(frozen=True)
class AIReply:
    result: Feedback
    history: tuple[Any, ...]


class UnavailableAI:
    async def initial(self):
        raise AIError("ai_not_configured", "The terminal is not connected yet. Please try again later.", 503)

    async def evaluate(self, **kwargs):
        return await self.initial()

    async def aclose(self):
        pass


class DeepSeekAI:
    def __init__(self, api_key: str, model: str, *, transport: httpx.AsyncBaseTransport | None = None):
        self.model = model
        self.prompts = {name: (PROMPTS / f"{name}.txt").read_text(encoding="utf-8")
                        for name in ("system", "initial", "trial", "last_try", "fail")}
        # HTTPX recognizes bare IPv6 but builds an invalid URL from ::1/128.
        # This host-only CIDR means exactly ::1; preserve all other settings.
        for name in ("NO_PROXY", "no_proxy"):
            if name in os.environ:
                os.environ[name] = ",".join(
                    "::1" if item.strip() == "::1/128" else item
                    for item in os.environ[name].split(",")
                )
        # HTTPX does not retry by default; the visitor explicitly retries failed turns.
        self.client = httpx.AsyncClient(
            base_url="https://api.deepseek.com",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=httpx.Timeout(40, connect=10),
            transport=transport,
            trust_env=transport is None,
        )

    async def _generate(self, history, content):
        user_turn = {"role": "user", "content": content}
        try:
            response = await self.client.post("/chat/completions", json={
                "model": self.model,
                "messages": [{"role": "system", "content": self.prompts["system"]}, *history, user_turn],
                "response_format": {"type": "json_object"},
                "thinking": {"type": "disabled"},
                "temperature": 1.0,
                "max_tokens": 2048,
                "stream": False,
            })
            response.raise_for_status()
            choice = response.json()["choices"][0]
            message = choice["message"]
            if choice.get("finish_reason") != "stop" or message.get("refusal"):
                raise ValueError("Incomplete or refused response")
            result = Feedback.model_validate_json(message["content"])
            if not all(line.strip() and len(line) <= 160 for line in result.feedback):
                raise ValueError("Invalid instruction lines")
            # Thinking is disabled. Only the validated assistant text is replayed.
            model_turn = {"role": "assistant", "content": message["content"]}
            return AIReply(result, (*history, user_turn, model_turn))
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            logger.warning("DeepSeek request failed: HTTP %s", status)
            if status == 429:
                raise AIError("ai_busy", "The evaluator is busy. Your drawing is safe; please try again shortly.", 503) from None
            if status in (401, 402, 403):
                raise AIError("ai_not_available", "The terminal is temporarily unavailable. Please try again later.", 503) from None
            raise AIError("ai_unavailable", "The evaluator could not be reached. Please try again.", 502) from None
        except httpx.TimeoutException:
            raise AIError("ai_timeout", "The evaluator took too long. Please retry; this attempt was not counted.", 504) from None
        except (ValidationError, ValueError, KeyError, IndexError, TypeError, AttributeError):
            raise AIError("invalid_ai_response", "The evaluator returned an unreadable response. Please try again.") from None
        except Exception as exc:
            # Never log response bodies or headers: they can contain private data.
            logger.warning("DeepSeek transport failure: %s", type(exc).__name__)
            raise AIError("ai_unavailable", "The evaluator could not be reached. Please try again.") from None

    async def initial(self):
        emotions = ", ".join(random.sample(EMOTIONS, 3))
        prompt = self.prompts["initial"].replace("EMOTIONS_PLACEHOLDER", emotions)
        reply = await self._generate((), prompt)
        if reply.result.is_satisfied or reply.result.feedback[0] != "Draw me a sheep.":
            raise AIError("invalid_ai_response", "The terminal could not prepare an instruction. Please try again.")
        return reply

    async def evaluate(self, *, history, vision, image, round_number):
        stage = "trial" if round_number < 3 else "last_try" if round_number == 3 else "fail"
        prompt = self.prompts[stage].replace("SCENE_PLACEHOLDER", vision)
        return await self._generate(history, [
            {"type": "image_url", "image_url": {
                "url": "data:image/png;base64," + base64.b64encode(image).decode("ascii"),
                "detail": "high",
            }},
            {"type": "text", "text": prompt},
        ])

    async def aclose(self):
        await self.client.aclose()
