"""Isolated Hermes API fakes: no Hermes install or user configuration needed."""
import copy
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import types

import pytest


@pytest.fixture
def plugin(monkeypatch):
    state = {"env": {}, "config": {}, "saved": []}
    for name in ("agent", "agent.browser_provider", "agent.secret_scope", "hermes_cli", "hermes_cli.config"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    sys.modules["agent.browser_provider"].BrowserProvider = type("BrowserProvider", (), {})
    sys.modules["agent.secret_scope"].get_secret = lambda key: state["env"].get(key)
    config = sys.modules["hermes_cli.config"]
    config.load_config = lambda: copy.deepcopy(state["config"])
    def save_config(value):
        state["config"] = copy.deepcopy(value)
        state["saved"].append(value)
    config.save_config = save_config
    config.save_env_value = lambda key, value: state["env"].__setitem__(key, value)
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("tandem_test_plugin", root / "__init__.py", submodule_search_locations=[str(root)])
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    cli = __import__(spec.name + ".cli", fromlist=["handle"])
    provider = __import__(spec.name + ".provider", fromlist=["TandemBrowserProvider"])
    module.cli = cli
    module.handle = cli.handle
    module.setup_parser = cli.setup_parser
    module.slash_status = cli.slash_status
    module.TandemBrowserProvider = provider.TandemBrowserProvider
    yield module, state
    for name in list(sys.modules):
        if name.startswith("tandem_test_plugin."):
            del sys.modules[name]


@pytest.fixture
def gateway():
    state = {"requests": [], "code": 200, "bad_ws": False, "health_ok": True, "mcp": True}
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state["requests"].append((self.path, self.headers.get("Authorization")))
            self.send_response(state["code"])
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if self.path == "/api/health":
                body = {"ok": state["health_ok"], "cdp": True, "mcp": state["mcp"]}
            else:
                body = {} if state["bad_ws"] else {"webSocketDebuggerUrl": "ws://" + self.headers["Host"] + self.path.replace("/json/version", "/devtools/browser/test")}
            self.wfile.write(json.dumps(body).encode())
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}", state
    server.shutdown()
    server.server_close()
    thread.join()
