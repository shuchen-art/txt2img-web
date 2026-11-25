"""Opt-in DeepSeek check: one initial instruction and up to two image evaluations.

Run explicitly with `.venv/bin/python tests/live_check.py`. Uses .env and API quota.
Never collected by pytest. No credentials, hidden scenes, or scores are printed.
"""
import asyncio
import base64
from io import BytesIO
from pathlib import Path
import sys
import time
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
from PIL import Image, ImageDraw
from app import create_app


def sample_drawing(number):
    image = Image.new("RGB", (640, 480), "white")
    pen = ImageDraw.Draw(image)
    pen.ellipse((170, 170, 390, 310), outline="black", width=5)
    pen.ellipse((365, 160, 435, 235), outline="black", width=5)
    for x in (210, 250, 315, 350):
        pen.line((x, 300, x, 365), fill="black", width=5)
    pen.ellipse((405, 184, 411, 190), fill="black")
    if number == 2:
        pen.line((475, 85, 475, 375), fill="black", width=5)
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


async def check():
    app = create_app(allowlist={"live@local.test": "Human #00000"})
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test", trust_env=False) as client:
            started = time.monotonic()
            response = await client.post("/api/sessions", json={"email": "live@local.test"})
            print("Start:", response.status_code, "elapsed:", round(time.monotonic() - started, 1), "s", flush=True)
            if response.status_code != 201:
                print("Error:", response.json().get("error", {}).get("code"), flush=True)
                return 1
            data = response.json()
            print("Instruction:", data["instructions"], flush=True)
            sid = data["session_id"]
            try:
                for number in (1, 2):
                    body = {"submission_id": str(uuid4()), "round": number, "image_base64": sample_drawing(number)}
                    started = time.monotonic()
                    response = await client.post(f"/api/sessions/{sid}/drawings", json=body)
                    print("Drawing", number, ":", response.status_code, "elapsed:", round(time.monotonic() - started, 1), "s", flush=True)
                    if response.status_code != 200:
                        print("Error:", response.json().get("error", {}).get("code"), flush=True)
                        return 1
                    verdict = response.json()
                    print("Verdict:", verdict["state"], verdict["feedback"], flush=True)
                    repeated = await client.post(f"/api/sessions/{sid}/drawings", json=body)
                    if repeated.status_code != 200 or repeated.json() != verdict:
                        print("Replay failed", flush=True)
                        return 1
                    print("Replay: cached response matched", flush=True)
                    if verdict["state"] != "retry":
                        break
            finally:
                await client.delete(f"/api/sessions/{sid}")
            print("Live DeepSeek check: passed", flush=True)
            return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(check()))
