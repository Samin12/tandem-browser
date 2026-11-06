import argparse
import json


def invoke(module, *args):
    parser = argparse.ArgumentParser()
    module.setup_parser(parser)
    parsed = parser.parse_args(args)
    parsed.func(parsed)


def test_setup_and_remove(plugin, gateway, capsys):
    module, state = plugin
    url, server = gateway
    state["env"]["TANDEM_AGENT_TOKEN"] = "private-test-token"
    state["config"] = {"other": {"keep": True}, "mcp_servers": {"other": {"enabled": True}}}
    invoke(module, "setup", "--url", url + "/mcp/")
    entry = state["config"]["mcp_servers"]["tandem"]
    assert entry == {"url": url + "/mcp", "connect_timeout": 30.0, "timeout": 180,
                     "headers": {"Authorization": "Bearer ${TANDEM_AGENT_TOKEN}"}, "enabled": True}
    assert state["config"]["browser"]["cloud_provider"] == "tandem"
    assert "private-test-token" not in json.dumps(state["config"])
    assert state["env"]["TANDEM_URL"] == url
    assert server["requests"] == [("/api/health", None), ("/cdp/private-test-token/json/version", None)]
    assert "start a new Hermes session" in capsys.readouterr().out
    invoke(module, "remove")
    assert "tandem" not in state["config"]["mcp_servers"]
    assert "cloud_provider" not in state["config"]["browser"]
    assert state["config"]["other"] == {"keep": True}
    assert state["config"]["mcp_servers"]["other"] == {"enabled": True}
    assert state["env"]["TANDEM_AGENT_TOKEN"] == "private-test-token"


def test_prompt_and_flags(plugin, gateway, monkeypatch):
    module, state = plugin
    url, _ = gateway
    monkeypatch.setattr("builtins.input", lambda prompt: url)
    monkeypatch.setattr(module.cli.getpass, "getpass", lambda prompt: "prompted-token")
    invoke(module, "setup", "--no-browser-tools", "--no-mcp")
    assert state["config"] == {}
    assert state["env"]["TANDEM_AGENT_TOKEN"] == "prompted-token"


def test_overwrite_confirmation(plugin, gateway, monkeypatch):
    module, state = plugin
    url, _ = gateway
    state["env"].update(TANDEM_URL=url, TANDEM_AGENT_TOKEN="test-token")
    state["config"] = {"mcp_servers": {"tandem": {"url": "https://other.example/mcp"}}}
    monkeypatch.setattr("builtins.input", lambda prompt: "")
    invoke(module, "setup")
    assert not state["saved"]
    invoke(module, "setup", "--yes")
    assert state["config"]["mcp_servers"]["tandem"]["url"] == url + "/mcp"


def test_remove_preserves_other_provider(plugin):
    module, state = plugin
    state["config"] = {"browser": {"cloud_provider": "other"}}
    invoke(module, "remove")
    assert state["config"]["browser"]["cloud_provider"] == "other"


def test_status_slash_and_open(plugin, gateway, capsys, monkeypatch):
    module, state = plugin
    url, _ = gateway
    state["env"].update(TANDEM_URL=url, TANDEM_AGENT_TOKEN="test-token")
    invoke(module, "setup")
    capsys.readouterr()
    invoke(module, "status")
    text = capsys.readouterr().out
    assert "healthy" in text and "accepted" in text and "configured" in text
    assert "test-token" not in text
    assert f"Watch or take over: {url}/" in module.slash_status()
    opened = []
    monkeypatch.setattr(module.cli.sys, "platform", "darwin")
    monkeypatch.setattr(module.cli.subprocess, "run", lambda args, **kw: opened.append(args))
    invoke(module, "open")
    assert opened == [["open", url + "/"]]


def test_failed_setup_does_not_write(plugin, gateway):
    import pytest
    module, state = plugin
    url, server = gateway
    state["env"].update(TANDEM_URL=url, TANDEM_AGENT_TOKEN="test-token")
    server["code"] = 401
    with pytest.raises(SystemExit):
        invoke(module, "setup")
    assert not state["saved"]


def test_registration(plugin):
    module, _ = plugin
    calls = {}
    class Context:
        def __getattr__(self, name):
            return lambda *args, **kwargs: calls.__setitem__(name, (args, kwargs))
    module.register(Context())
    assert set(calls) == {"register_browser_provider", "register_cli_command", "register_command", "register_skill"}
    assert calls["register_skill"][0][1].is_file()


def test_status_reports_rejected_token(plugin, gateway):
    module, state = plugin
    url, server = gateway
    state["env"].update(TANDEM_URL=url, TANDEM_AGENT_TOKEN="secret-test-token")
    server["code"] = 401
    text = module.slash_status()
    assert "rejected" in text
    assert "secret-test-token" not in text
    assert f"Watch or take over: {url}/" in text


def test_rerun_accepts_entry_with_expanded_token(plugin, gateway, monkeypatch):
    # Hermes' load_config() expands ${TANDEM_AGENT_TOKEN}; a rerun must not ask to replace it.
    module, state = plugin
    url, _ = gateway
    state["env"].update(TANDEM_URL=url, TANDEM_AGENT_TOKEN="test-token")
    entry = module.cli.mcp_entry(url)
    entry["headers"] = {"Authorization": "Bearer test-token"}
    state["config"] = {"mcp_servers": {"tandem": entry}}
    monkeypatch.setattr("builtins.input", lambda prompt: (_ for _ in ()).throw(AssertionError(prompt)))
    invoke(module, "setup")
    assert state["config"]["mcp_servers"]["tandem"]["headers"]["Authorization"] == "Bearer ${TANDEM_AGENT_TOKEN}"
    state["config"]["mcp_servers"]["tandem"] = entry
    assert "Tandem MCP: configured" in module.cli.status_text()


def test_mcp_down_warns_but_still_configures(plugin, gateway, capsys):
    # The gateway can report MCP down for a moment; the CDP token check decides.
    module, state = plugin
    url, server = gateway
    state["env"]["TANDEM_AGENT_TOKEN"] = "test-token"
    server.update(health_ok=False, mcp=False)
    invoke(module, "setup", "--url", url)
    assert state["config"]["mcp_servers"]["tandem"]["url"] == url + "/mcp"
    assert "MCP tools as down" in capsys.readouterr().err
