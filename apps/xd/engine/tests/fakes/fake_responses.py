"""Scripted OpenAI Responses server (streaming SSE) for codex — records requests, plays a tool-call script."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeResponses:
    def __init__(self, script, namespace="mcp__connector"):
        self.script = list(script)
        self.requests = []
        self.main = []
        self.namespace = namespace
        self._lock = threading.Lock()
        srv = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(n) or b"{}"
                try:
                    body = json.loads(raw)
                except Exception:
                    body = {"raw": raw[:200].decode("utf-8", "replace")}
                with srv._lock:
                    srv.requests.append({"path": self.path, "body": body})
                    srv.main.append(body)
                    step = srv.script.pop(0) if srv.script else (lambda b: ("text", "done"))
                return self._sse(step(body), len(srv.main))

            def do_GET(self):
                self.send_response(404)
                self.end_headers()

            def _sse(self, action, n):
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.end_headers()

                def ev(data):
                    self.wfile.write(
                        f"event: {data['type']}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()
                    )

                rid = f"resp_{n}"
                ev({"type": "response.created", "response": {"id": rid}})
                if action[0] == "tool":
                    _, name, inp = action
                    item = {"type": "function_call", "id": f"fc_{n}", "call_id": f"call_{n}",
                            "name": name, "arguments": json.dumps(inp, ensure_ascii=False), "status": "completed"}
                    if srv.namespace:
                        item["namespace"] = srv.namespace
                else:
                    item = {"type": "message", "role": "assistant", "id": f"msg_{n}", "status": "completed",
                            "content": [{"type": "output_text", "text": action[1], "annotations": []}]}
                ev({"type": "response.output_item.added", "output_index": 0, "item": item})
                ev({"type": "response.output_item.done", "output_index": 0, "item": item})
                ev({"type": "response.completed", "response": {
                    "id": rid, "status": "completed", "output": [item],
                    "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15,
                              "input_tokens_details": {"cached_tokens": 0},
                              "output_tokens_details": {"reasoning_tokens": 0}}}})
                self.wfile.flush()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
