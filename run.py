"""Start the local terminal with one process; no external database is required."""
import argparse
import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="txt2img⁻¹ local web terminal")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run("app:create_app", factory=True, host=args.host, port=args.port, workers=1, access_log=False)
