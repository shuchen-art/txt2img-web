"""Explicitly labelled, local-only UI test fixture. Never used by run.py."""
import asyncio
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ai_service import AIError, AIReply, Feedback
from app import ROOT, create_app
from fastapi.responses import HTMLResponse, JSONResponse
import uvicorn


class BrowserFixture:
    def __init__(self, fail_first=True):
        self.count = 0
        self.failed_once = not fail_first

    async def initial(self):
        self.count += 1
        await asyncio.sleep(.25)
        result = Feedback(detail=str(self.count), is_satisfied=False,
                          feedback=["Draw me a sheep.", "A tall line cuts the space.", "Make the body angular."])
        return AIReply(result, ())

    async def evaluate(self, **kwargs):
        await asyncio.sleep(.25)
        if not self.failed_once:
            self.failed_once = True
            raise AIError("test_failure", "Test fixture: simulated connection failure. Retry the same drawing.")
        satisfied = int(kwargs["vision"]) % 2 == 0
        lines = (["Your drawing is accepted.", "The form matches.", "Session complete."] if satisfied else
                 ["Attempt limit reached.", "The scene was not matched.", "Process terminated."] if kwargs["round_number"] == 4 else
                 ["You drew a curved form.", "Use straight lines.", "Move the sheep lower."])
        return AIReply(Feedback(detail="test-only", is_satisfied=satisfied, feedback=lines), ())

    async def aclose(self):
        pass


def build(scenario="default"):
    clock = [0.0]
    engine = BrowserFixture(fail_first=scenario == "default")
    app = create_app(engine, clock=lambda: clock[0], ttl=1) if scenario == "expired" else create_app(engine)
    dropped = False

    @app.middleware("http")
    async def label_fixture(request, call_next):
        nonlocal dropped
        if request.url.path == "/":
            html = (ROOT / "static/index.html").read_text()
            html = html.replace("<body>", f'<body><p class="noscript">TEST FIXTURE — no live AI. Scenario: {scenario}. First session terminates; second accepts. Allowlist: allowlist.csv (cleavcw@hkust-gz.edu.cn).</p>')
            return HTMLResponse(html)
        is_submission = request.method == "POST" and request.url.path.endswith("/drawings")
        if is_submission and scenario == "expired":
            clock[0] += 2
        response = await call_next(request)
        if is_submission and scenario == "lost-response" and not dropped and response.status_code == 200:
            dropped = True
            return JSONResponse({"error": {"code": "test_response_lost", "message": "Test fixture: response lost after server commit. Please retry."}}, status_code=502)
        return response
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", choices=("default", "lost-response", "expired"), default="default")
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    uvicorn.run(build(args.scenario), host="127.0.0.1", port=args.port, access_log=False)
