"""Scripted Anthropic Messages server (streaming SSE) — records requests, plays a tool-call script."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeAnthropic:
    def __init__(self, script):
        # script: list of callables(request_body) -> ("tool", name, input) | ("text", str)
        self.script = list(script)
        self.requests = []
        self.main = []
        self._lock = threading.Lock()
        srv = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get("content-length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
                with srv._lock:
                    srv.requests.append({"path": self.path, "body": body})
                tools = body.get("tools") or []
                is_main = any(str(t.get("name", "")).startswith("mcp__connector__") for t in tools)
                if "count_tokens" in self.path:
                    return self._json({"input_tokens": 10})
                if not is_main:
                    return self._sse(("text", "ok"))
                with srv._lock:
                    srv.main.append(body)
                    step = srv.script.pop(0) if srv.script else (lambda b: ("text", "done"))
                return self._sse(step(body))

            def do_GET(self):
                self.send_response(404)
                self.end_headers()

            def _json(self, obj):
                data = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _sse(self, action):
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()

                def ev(name, data):
                    self.wfile.write(f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode())

                ev("message_start", {"type": "message_start", "message": {
                    "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5",
                    "content": [], "stop_reason": None, "stop_sequence": None,
                    "usage": {"input_tokens": 10, "output_tokens": 1}}})
                if action[0] == "tool":
                    _, name, inp = action
                    ev("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {
                        "type": "tool_use", "id": f"toolu_{len(srv.main)}", "name": name, "input": {}}})
                    ev("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {
                        "type": "input_json_delta", "partial_json": json.dumps(inp, ensure_ascii=False)}})
                    ev("content_block_stop", {"type": "content_block_stop", "index": 0})
                    stop = "tool_use"
                else:
                    ev("content_block_start", {"type": "content_block_start", "index": 0,
                                               "content_block": {"type": "text", "text": ""}})
                    ev("content_block_delta", {"type": "content_block_delta", "index": 0,
                                               "delta": {"type": "text_delta", "text": action[1]}})
                    ev("content_block_stop", {"type": "content_block_stop", "index": 0})
                    stop = "end_turn"
                ev("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                                     "usage": {"output_tokens": 5}})
                ev("message_stop", {"type": "message_stop"})
                self.wfile.flush()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
