from agents.idp_agent import _service_tier_kwargs


def test_flex_from_the_environment(monkeypatch):
    monkeypatch.setenv("CHAT_SERVICE_TIER", "flex")
    assert _service_tier_kwargs() == {"service_tier": "flex"}


def test_standard_when_unset_or_unknown(monkeypatch):
    monkeypatch.delenv("CHAT_SERVICE_TIER", raising=False)
    assert _service_tier_kwargs() == {}
    monkeypatch.setenv("CHAT_SERVICE_TIER", "cheap")
    assert _service_tier_kwargs() == {}
