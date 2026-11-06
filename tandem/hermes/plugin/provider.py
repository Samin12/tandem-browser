"""CDP session discovery for Tandem's shared browser (no third-party dependencies)."""

import json
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

from agent.browser_provider import BrowserProvider
from agent.secret_scope import get_secret


def normalize_url(url):
    url = (url or "").strip().rstrip("/")
    if url.endswith("/mcp"):
        url = url[:-4].rstrip("/")
    parts = urlsplit(url)
    if (parts.scheme not in ("http", "https") or not parts.netloc
            or parts.username or parts.password or parts.query or parts.fragment):
        raise ValueError("Set TANDEM_URL to your Tandem http(s) address, without credentials.")
    return url


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a credential-bearing discovery path to another endpoint.
        return None


def request_json(url):
    try:
        with build_opener(_NoRedirect).open(url, timeout=10) as response:
            result = json.load(response)
        if not isinstance(result, dict):
            raise ValueError("Expected an object")
        return result
    except HTTPError as exc:
        if exc.code in (401, 403):
            message = "Tandem rejected the agent token. Run hermes tandem setup to check it."
        else:
            message = f"Tandem returned HTTP {exc.code}. Check the gateway and CDP settings."
        raise RuntimeError(message) from None
    except (URLError, OSError, ValueError):
        # Exception strings can contain the complete URL, including the token.
        raise RuntimeError("Could not reach Tandem or read its response. Check the address and server.") from None


def discover(url, token):
    result = request_json(f"{normalize_url(url)}/cdp/{quote(token, safe='')}/json/version")
    ws = result.get("webSocketDebuggerUrl")
    if not isinstance(ws, str) or urlsplit(ws).scheme not in ("ws", "wss"):
        raise RuntimeError("Tandem did not return a CDP WebSocket address. Check that CDP is enabled.")
    return ws


class TandemBrowserProvider(BrowserProvider):
    name = "tandem"
    display_name = "Tandem Browser"

    def is_available(self):
        return bool(get_secret("TANDEM_URL") and get_secret("TANDEM_AGENT_TOKEN"))

    def create_session(self, task_id):
        url, token = get_secret("TANDEM_URL"), get_secret("TANDEM_AGENT_TOKEN")
        if not url or not token:
            raise ValueError("Set TANDEM_URL and TANDEM_AGENT_TOKEN with hermes tandem setup.")
        ws = discover(url, token)
        return {"session_name": f"tandem-{task_id}", "bb_session_id": f"tandem-{task_id}",
                "cdp_url": ws, "features": {"tandem": True, "shared": True}}

    def close_session(self, session_id):
        return True

    def emergency_cleanup(self, session_id):
        pass

    def get_setup_schema(self):
        return {
            "name": self.display_name, "badge": "self-hosted",
            "tag": "Your shared, always-on browser",
            "env_vars": [
                {"key": "TANDEM_URL", "prompt": "Tandem address", "secret": False},
                {"key": "TANDEM_AGENT_TOKEN", "prompt": "Agent token from ./tandem hermes-config"},
            ],
            "post_setup": "agent_browser",
        }
