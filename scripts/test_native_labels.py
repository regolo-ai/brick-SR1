#!/usr/bin/env python3
"""Verify real checkpoint outputs reach the correct named routing dimensions."""

import json
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


class Classifier(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"choices": [{"message": {"content": "easy"}}]}).encode())

    def log_message(self, *_args):
        pass


def main():
    binary, models = (str(Path(value).resolve()) for value in sys.argv[1:3])
    root = Path(__file__).resolve().parents[1]
    baseline = json.loads((root / "apps/router/candle-binding/testdata/capability-baseline.json").read_text())
    physical = list(baseline["labels"].values())
    row = next(row for row in baseline["cases"] if row["text"] == "Hello.")
    server = HTTPServer(("127.0.0.1", 0), Classifier)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with tempfile.TemporaryDirectory(prefix="brick-labels-") as directory:
            config = {
                "config_version": 1,
                "brick": {"enabled": True},
                "default_model": "test",
                "model_config": {"test": {}},
                "skill_router": {
                    "enabled": True,
                    "capabilities": sorted(physical),
                    "capability_model": {"model_id": "installed", "labels": physical},
                    "complexity_model": {
                        "base_url": f"http://127.0.0.1:{server.server_port}",
                        "protocol": "openai",
                        "model_name": "offline-classifier",
                    },
                    "models": [{"model": "test", "skill_vector": [0.5] * 6}],
                },
            }
            file = Path(directory) / "config.yaml"
            for declared in [physical, None]:
                if declared is None:
                    del config["skill_router"]["capability_model"]["labels"]
                file.write_text(json.dumps(config))
                output = subprocess.check_output(
                    [
                        binary,
                        "--config",
                        str(file),
                        "--model-dir",
                        models,
                        "--metrics-port",
                        "0",
                        "--route-test",
                        row["text"],
                    ],
                    text=True,
                )
                result = json.loads(output)
                expected = dict(zip(physical, row["probabilities"], strict=True))
                for label, value in expected.items():
                    assert abs(result["Capability"][label] - value) < 1e-6, (label, result)
            print("PASS: real ModernBERT probabilities map to their named dimensions in Go routing")
    finally:
        server.shutdown()
        server.server_close()
        worker.join()


if __name__ == "__main__":
    main()
