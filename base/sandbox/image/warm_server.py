#!/usr/bin/env python3
"""Warm sandbox server -- pre-warmed HTTP endpoint for fast code execution.

Runs as a long-lived process inside sandbox pods. Receives code via POST,
writes it to a temp directory, invokes run.sh, and returns the JSON result.
Uses stdlib only (no third-party dependencies required in the sandbox image).

Readiness probe returns 503 while a request is being processed, causing K8s
to remove the pod from Service endpoints and route to an idle pod.

Auto-recycles after MAX_EXECUTIONS to limit long-running process risk.
"""

import http.server
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

MAX_EXECUTIONS = int(os.environ.get("WARM_MAX_EXECUTIONS", "100"))
PORT = int(os.environ.get("WARM_PORT", "8080"))
EXECUTION_TIMEOUT = int(os.environ.get("WARM_EXECUTION_TIMEOUT", "30"))

_lock = threading.Lock()
_busy = False
_execution_count = 0
_start_time = time.monotonic()


class WarmHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        sys.stderr.write(
            f"[warm-server] {self.address_string()} - {fmt % args}\n"
        )

    def do_GET(self):
        if self.path == "/healthz":
            self._respond(200, {"status": "ok", "uptime_s": int(time.monotonic() - _start_time)})
        elif self.path == "/readyz":
            if _busy:
                self._respond(503, {"status": "busy", "executions": _execution_count})
            else:
                self._respond(200, {"status": "ready", "executions": _execution_count})
        else:
            self._respond(404, {"error": "not found"})

    def do_POST(self):
        global _busy, _execution_count

        if self.path != "/execute":
            self._respond(404, {"error": "not found"})
            return

        with _lock:
            if _busy:
                self._respond(503, {"error": "busy"})
                return
            _busy = True

        work_dir = None
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length == 0:
                self._respond(400, {"error": "empty request body", "exit_code": 1})
                return

            body = json.loads(self.rfile.read(content_length))
            language = body.get("language", "bash")
            code = body.get("code", "")
            filename = body.get("filename", "script.sh")

            if not code.strip():
                self._respond(200, {"exit_code": 0, "lint": {"passed": True}, "execution": {"output": "", "exit_code": 0}})
                return

            work_dir = tempfile.mkdtemp(dir="/tmp")
            code_dir = os.path.join(work_dir, "code")
            os.makedirs(code_dir)

            with open(os.path.join(code_dir, "metadata.json"), "w") as f:
                json.dump({"language": language, "filename": filename}, f)

            with open(os.path.join(code_dir, filename), "w") as f:
                f.write(code)

            env = os.environ.copy()
            env["SANDBOX_CODE_DIR"] = code_dir

            result = subprocess.run(
                ["/sandbox/run.sh"],
                capture_output=True,
                text=True,
                timeout=EXECUTION_TIMEOUT,
                cwd=work_dir,
                env=env,
            )

            try:
                output = json.loads(result.stdout)
            except (json.JSONDecodeError, ValueError):
                output = {
                    "error": "Failed to parse run.sh output",
                    "stdout": result.stdout[:4096],
                    "stderr": result.stderr[:4096],
                    "exit_code": result.returncode,
                }

            self._respond(200, output)

        except subprocess.TimeoutExpired:
            self._respond(200, {"error": "execution timed out", "exit_code": 124})
        except Exception as e:
            self._respond(500, {"error": str(e), "exit_code": 1})
        finally:
            if work_dir:
                shutil.rmtree(work_dir, ignore_errors=True)
            with _lock:
                _busy = False
                _execution_count += 1

            if _execution_count >= MAX_EXECUTIONS:
                self.log_message("Reached %d executions, recycling pod", MAX_EXECUTIONS)
                threading.Thread(target=_graceful_shutdown, daemon=True).start()

    def _respond(self, status: int, body: dict):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def _graceful_shutdown():
    """Give in-flight response time to flush, then exit."""
    time.sleep(1)
    os._exit(0)


def main():
    server = http.server.HTTPServer(("0.0.0.0", PORT), WarmHandler)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    sys.stderr.write(f"[warm-server] Listening on :{PORT}, max_executions={MAX_EXECUTIONS}\n")
    try:
        server.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        server.server_close()


if __name__ == "__main__":
    main()
