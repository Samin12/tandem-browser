import pytest


@pytest.mark.parametrize("suffix", ["", "/", "/mcp", "/mcp/"])
def test_url_normalization(plugin, gateway, suffix):
    module, state = plugin
    url, server = gateway
    state["env"].update(TANDEM_URL=url + suffix, TANDEM_AGENT_TOKEN="test-token")
    provider = module.TandemBrowserProvider()
    assert provider.is_available()
    assert server["requests"] == []
    session = provider.create_session("task")
    assert session == {"session_name": "tandem-task", "bb_session_id": "tandem-task",
                       "cdp_url": url.replace("http:", "ws:") + "/cdp/test-token/devtools/browser/test",
                       "features": {"tandem": True, "shared": True}}
    assert server["requests"] == [("/cdp/test-token/json/version", None)]
    assert provider.close_session("task") is True
    assert provider.emergency_cleanup("task") is None
    assert len(server["requests"]) == 1


def test_missing_config(plugin):
    provider = plugin[0].TandemBrowserProvider()
    assert not provider.is_available()
    with pytest.raises(ValueError, match="hermes tandem setup"):
        provider.create_session("task")


@pytest.mark.parametrize("code", [401, 403, 500])
def test_http_errors_do_not_leak_token(plugin, gateway, code):
    module, state = plugin
    url, server = gateway
    server["code"] = code
    token = "secret-test-token"
    state["env"].update(TANDEM_URL=url, TANDEM_AGENT_TOKEN=token)
    with pytest.raises(RuntimeError) as error:
        module.TandemBrowserProvider().create_session("task")
    assert token not in str(error.value)
    assert error.value.__suppress_context__


def test_network_error_is_sanitized(plugin, monkeypatch):
    from urllib.error import URLError
    module, state = plugin
    state["env"].update(TANDEM_URL="http://localhost", TANDEM_AGENT_TOKEN="secret-test-token")
    provider_module = __import__(module.__name__ + ".provider", fromlist=["build_opener"])
    class Broken:
        def open(self, *args, **kwargs):
            assert kwargs["timeout"] == 10
            raise URLError("http://localhost/cdp/secret-test-token")
    monkeypatch.setattr(provider_module, "build_opener", lambda *args: Broken())
    with pytest.raises(RuntimeError) as error:
        module.TandemBrowserProvider().create_session("task")
    assert "secret-test-token" not in str(error.value)


def test_invalid_discovery(plugin, gateway):
    module, state = plugin
    url, server = gateway
    server["bad_ws"] = True
    state["env"].update(TANDEM_URL=url, TANDEM_AGENT_TOKEN="test-token")
    with pytest.raises(RuntimeError, match="WebSocket"):
        module.TandemBrowserProvider().create_session("task")


@pytest.mark.parametrize("url", ["", "browser.example.com", "ftp://example.com", "https://user:pass@example.com", "https://example.com/?token=secret"])
def test_invalid_url(plugin, url):
    module, state = plugin
    state["env"].update(TANDEM_URL=url, TANDEM_AGENT_TOKEN="test-token")
    with pytest.raises(ValueError):
        module.TandemBrowserProvider().create_session("task")
