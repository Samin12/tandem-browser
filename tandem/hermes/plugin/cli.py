"""User-invoked configuration and status commands."""

import getpass
import subprocess
import sys

from agent.secret_scope import get_secret
from hermes_cli.config import load_config, save_config, save_env_value

from .provider import discover, normalize_url, request_json


def mcp_entry(url):
    return {"url": f"{url}/mcp", "connect_timeout": 30.0, "timeout": 180,
            "headers": {"Authorization": "Bearer ${TANDEM_AGENT_TOKEN}"}, "enabled": True}


def is_tandem_entry(entry, url):
    # load_config() expands ${TANDEM_AGENT_TOKEN}, so compare the address, not the whole entry.
    return isinstance(entry, dict) and entry.get("url") == f"{url}/mcp"


def viewer_url():
    return normalize_url(get_secret("TANDEM_URL"))


def status_text():
    cfg = load_config()
    lines = []
    try:
        url = viewer_url()
    except ValueError:
        return "Tandem address is missing or invalid. Run hermes tandem setup."
    try:
        health = request_json(f"{url}/api/health")
        lines.append("Gateway: " + ("healthy" if health.get("ok") else "not healthy"))
        lines.append(f"Services: CDP {'on' if health.get('cdp') else 'off'}, MCP {'on' if health.get('mcp') else 'off'}")
    except RuntimeError as exc:
        lines.append(f"Gateway: {exc}")
    token = get_secret("TANDEM_AGENT_TOKEN")
    if token:
        try:
            discover(url, token)
            lines.append("Agent token: accepted (CDP)")
        except RuntimeError as exc:
            lines.append(f"Agent token: {exc}")
    else:
        lines.append("Agent token: missing")
    entry = cfg.get("mcp_servers", {}).get("tandem")
    lines.append("Tandem MCP: " + ("configured" if is_tandem_entry(entry, url) else "missing or pointing elsewhere"))
    lines.append("Browser provider: " + ("tandem" if cfg.get("browser", {}).get("cloud_provider") == "tandem" else "not tandem"))
    lines.append(f"Viewer: {url}/")
    return "\n".join(lines)


def setup(args):
    url = normalize_url(args.url or get_secret("TANDEM_URL") or input("Tandem address: "))
    token = get_secret("TANDEM_AGENT_TOKEN") or getpass.getpass("Agent token (./tandem hermes-config on the server): ")
    if not token or not token.strip():
        raise ValueError("TANDEM_AGENT_TOKEN is required.")
    health = request_json(f"{url}/api/health")
    discover(url, token)  # the real check: the address answers and accepts this token
    if not args.no_mcp and not health.get("mcp"):
        print("Warning: Tandem reports its MCP tools as down right now. Setup continues; "
              "run hermes tandem status later to check.", file=sys.stderr)
    cfg = load_config()
    entry = mcp_entry(url)
    existing = cfg.get("mcp_servers", {}).get("tandem")
    if not args.no_mcp and existing is not None and not is_tandem_entry(existing, url) and not args.yes:
        if input("Replace the existing Tandem MCP configuration? (y/N) ").strip().lower() != "y":
            print("Setup cancelled; configuration was not changed.")
            return
    save_env_value("TANDEM_URL", url)
    save_env_value("TANDEM_AGENT_TOKEN", token)
    if not args.no_mcp:
        cfg.setdefault("mcp_servers", {})["tandem"] = entry
    if not args.no_browser_tools:
        cfg.setdefault("browser", {})["cloud_provider"] = "tandem"
    save_config(cfg)
    enabled = []
    if not args.no_browser_tools:
        enabled.append("browser tools")
    if not args.no_mcp:
        enabled.append("Tandem MCP tools")
    print(f"Tandem checked and credentials saved. Enabled: {', '.join(enabled) or 'credentials only'}.")
    print(f"Watch or take over: {url}/\nNext: start a new Hermes session.")


def remove():
    cfg = load_config()
    cfg.get("mcp_servers", {}).pop("tandem", None)
    if cfg.get("browser", {}).get("cloud_provider") == "tandem":
        cfg["browser"].pop("cloud_provider")
    save_config(cfg)
    print("Removed Tandem MCP and browser selection. Credentials in .env were left alone. Start a new Hermes session.")


def handle(args):
    try:
        if args.tandem_command == "setup":
            setup(args)
        elif args.tandem_command == "status":
            print(status_text())
        elif args.tandem_command == "remove":
            remove()
        elif args.tandem_command == "open":
            url = viewer_url() + "/"
            print(url)
            if sys.platform == "darwin":
                subprocess.run(["open", url], check=True)
    except (ValueError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from None
    except (EOFError, KeyboardInterrupt):
        print("Tandem setup cancelled.", file=sys.stderr)
        raise SystemExit(1) from None


def setup_parser(parser):
    subs = parser.add_subparsers(dest="tandem_command", required=True)
    setup_cmd = subs.add_parser("setup", help="Connect Hermes to Tandem")
    setup_cmd.add_argument("--url")
    setup_cmd.add_argument("--no-browser-tools", action="store_true")
    setup_cmd.add_argument("--no-mcp", action="store_true")
    setup_cmd.add_argument("--yes", action="store_true", help="Replace an existing Tandem MCP entry")
    for name in ("status", "open", "remove"):
        subs.add_parser(name)
    parser.set_defaults(func=handle)


def slash_status(raw_args=""):
    text = status_text()
    try:
        return text + f"\nWatch or take over: {viewer_url()}/"
    except ValueError:
        return text
