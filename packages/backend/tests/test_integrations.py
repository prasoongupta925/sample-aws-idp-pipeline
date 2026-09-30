"""Tests for the CRM webhook API (app/routers/integrations.py), no AWS calls.

The router is mounted on a test app (main.py includes it in the real app).
DynamoDB is a fake table that applies the module's SET / REMOVE updates and
attribute_exists conditions, and the boto3 Lambda client is stubbed. One test
runs the real delivery Lambda handler (packages/infra/src/functions/webhook)
in-process with stubbed DNS and HTTP, so the backend <-> Lambda contract and
the signature are checked end to end.
"""

import copy
import importlib.util
import io
import json
import os
import re
import sys
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.webhook_delivery as webhook_delivery
from app.config import get_config
from app.routers import integrations
from app.webhook_security import verify_signature

webhook_app = FastAPI()
webhook_app.include_router(integrations.router)
client = TestClient(webhook_app)

HEADERS = {"x-user-id": "admin"}
PROJECT_ID = "proj_demo"
BASE = f"/projects/{PROJECT_ID}/integrations/webhook"
FUNCTION_NAME = "idp-v2-webhook-delivery"
CRM_URL = "https://crm.example.com/hooks/idp?token=abc"

WEBHOOK_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "infra", "src", "functions", "webhook")
)


# ------------------------------------------------------------------ fakes
def _matches(condition, item) -> bool:
    expr = condition.get_expression()
    op, values = expr["operator"], expr["values"]
    if op == "AND":
        return _matches(values[0], item) and _matches(values[1], item)
    value = item.get(values[0].name)
    if op == "=":
        return value == values[1]
    if op == "BETWEEN":
        return value is not None and values[1] <= value <= values[2]
    raise AssertionError(f"unsupported key condition {op}")


def _conditional_failed():
    return ClientError(
        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "The conditional request failed"}},
        "UpdateItem",
    )


class FakeTable:
    """Base table: get/put, key-condition queries and the update subset app/ddb/webhooks.py uses."""

    def __init__(self, items=()):
        self.items = {(i["PK"], i["SK"]): copy.deepcopy(i) for i in items}
        self.updates = []
        self.puts = []
        self.queries = []

    def item(self, pk, sk):
        return self.items.get((pk, sk))

    def get_item(self, Key, ProjectionExpression=None, ConsistentRead=None):
        item = self.items.get((Key["PK"], Key["SK"]))
        if item is None:
            return {}
        if ProjectionExpression:
            names = [n.strip() for n in ProjectionExpression.split(",")]
            item = {n: item[n] for n in names if n in item}
        return {"Item": copy.deepcopy(item)}

    def put_item(self, Item):
        self.puts.append(copy.deepcopy(Item))
        self.items[(Item["PK"], Item["SK"])] = copy.deepcopy(Item)

    def update_item(self, Key, UpdateExpression, ConditionExpression=None, ExpressionAttributeValues=None):
        self.updates.append(UpdateExpression)
        item = self.items.get((Key["PK"], Key["SK"]))
        for clause in (ConditionExpression or "").split(" AND "):
            if not clause:
                continue
            match = re.fullmatch(r"attribute_exists\((\w+)\)", clause.strip())
            assert match, f"unsupported condition {clause}"
            if item is None or match.group(1) not in item:
                raise _conditional_failed()
        if item is None:
            item = self.items[(Key["PK"], Key["SK"])] = dict(Key)
        match = re.fullmatch(r"SET (?P<set>.+?)(?: REMOVE (?P<remove>.+))?", UpdateExpression)
        assert match, f"unsupported update {UpdateExpression}"
        for assignment in match.group("set").split(","):
            name, value = (part.strip() for part in assignment.split("="))
            item[name] = ExpressionAttributeValues[value]
        for name in (match.group("remove") or "").split(","):
            if name.strip():
                item.pop(name.strip(), None)

    def query(self, KeyConditionExpression, ScanIndexForward=True, Limit=None, **kwargs):
        self.queries.append({"ScanIndexForward": ScanIndexForward, "Limit": Limit, **kwargs})
        rows = sorted(
            (i for i in self.items.values() if _matches(KeyConditionExpression, i)),
            key=lambda i: i["SK"],
            reverse=not ScanIndexForward,
        )
        if Limit:
            rows = rows[:Limit]
        return {"Items": copy.deepcopy(rows)}


META = {
    "PK": f"PROJ#{PROJECT_ID}",
    "SK": "META",
    "data": {"project_id": PROJECT_ID, "name": "Demo", "description": "", "status": "active", "language": "en"},
    "created_at": "2026-09-28T00:00:00+00:00",
    "updated_at": "2026-09-28T00:00:00+00:00",
    "GSI1PK": "PROJECTS",
    "GSI1SK": "2026-09-28T00:00:00+00:00",
}


def _iso(ts: datetime) -> str:
    return ts.astimezone(UTC).isoformat(timespec="microseconds")


def delivery_item(at: datetime, n: int, **fields):
    item = {
        "PK": f"PROJ#{PROJECT_ID}",
        "SK": f"WHDLV#{_iso(at)}#d-{n}",
        "delivery_id": f"d-{n}",
        "at": _iso(at),
        "event": "file_check.completed",
        "status": "delivered",
        "http_status": Decimal(200),
        "attempts": Decimal(1),
        "expires_at": Decimal(int(at.timestamp()) + 7 * 86400),
    }
    item.update(fields)
    return item


@pytest.fixture(autouse=True)
def _reset_webhook_client():
    webhook_delivery._lambda_client = None
    yield
    webhook_delivery._lambda_client = None


@pytest.fixture
def table():
    fake = FakeTable([META])
    with patch("app.ddb.webhooks.get_table", return_value=fake):
        yield fake


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(get_config(), "webhook_function_name", FUNCTION_NAME)
    monkeypatch.setattr(get_config(), "retention_days", 7)


def canned_lambda(payload=None, function_error=None, raw=None, error=None):
    stub = MagicMock()
    if error is not None:
        stub.invoke.side_effect = error
        return stub
    body = raw if raw is not None else json.dumps(payload).encode("utf-8")
    response = {"StatusCode": 200, "Payload": io.BytesIO(body)}
    if function_error:
        response["FunctionError"] = function_error
    stub.invoke.return_value = response
    return stub


def use_lambda(stub):
    return patch("app.webhook_delivery.get_webhook_lambda_client", return_value=stub)


def meta(table):
    return table.item(f"PROJ#{PROJECT_ID}", "META")


def put(url, enabled):
    return client.put(BASE, headers=HEADERS, json={"url": url, "enabled": enabled})


def with_secret(table, secret="s" * 43, url=CRM_URL, enabled=False):
    item = meta(table)
    item["webhook_secret"] = secret
    if url:
        item["webhook_url"] = url
    item["webhook_enabled"] = enabled


# ------------------------------------------------------------------ 404 / auth
class TestProjectAndHeader:
    @pytest.mark.parametrize(
        ("method", "path", "body"),
        [
            ("get", "", None),
            ("put", "", {"url": CRM_URL, "enabled": False}),
            ("post", "/secret", None),
            ("post", "/test", None),
        ],
    )
    def test_unknown_project_is_404(self, table, configured, method, path, body):
        url = f"/projects/proj_missing/integrations/webhook{path}"
        response = client.request(method.upper(), url, headers=HEADERS, json=body)

        assert response.status_code == 404
        assert response.json() == {"detail": "Project not found"}
        assert not table.updates and not table.puts
        assert table.item("PROJ#proj_missing", "META") is None

    def test_user_header_is_required(self, table):
        assert client.get(BASE).status_code == 422

    def test_invalid_project_id_is_422(self, table):
        assert client.get("/projects/bad%20id/integrations/webhook", headers=HEADERS).status_code == 422


# ------------------------------------------------------------------ GET / PUT
class TestSettings:
    def test_defaults_without_webhook_fields(self, table, configured):
        response = client.get(BASE, headers=HEADERS)

        assert response.status_code == 200
        assert response.json() == {"url": None, "enabled": False, "secret_set": False, "deliveries": []}

    def test_put_stores_url_without_disturbing_other_fields(self, table, configured):
        before = copy.deepcopy(meta(table))
        response = put(CRM_URL, False)

        assert response.status_code == 200
        assert response.json() == {"url": CRM_URL, "enabled": False, "secret_set": False, "deliveries": []}
        after = meta(table)
        assert after["webhook_url"] == CRM_URL
        assert after["webhook_enabled"] is False
        assert {k: v for k, v in after.items() if not k.startswith("webhook_")} == before
        assert client.get(BASE, headers=HEADERS).json()["url"] == CRM_URL

    def test_put_strips_whitespace_and_blank_means_none(self, table, configured):
        assert put(f"  {CRM_URL}  ", False).json()["url"] == CRM_URL
        response = put("   ", False)

        assert response.status_code == 200
        assert response.json()["url"] is None
        assert "webhook_url" not in meta(table)

    def test_enable_needs_a_secret(self, table, configured):
        response = put(CRM_URL, True)

        assert response.status_code == 400
        assert response.json() == {"detail": "Generate a signing secret before enabling the webhook"}
        assert "webhook_url" not in meta(table)

    def test_enable_needs_a_url(self, table, configured):
        with_secret(table, url=None)
        response = put(None, True)

        assert response.status_code == 400
        assert response.json() == {"detail": "Set a webhook URL before enabling the webhook"}
        assert meta(table)["webhook_enabled"] is False

    def test_enable_with_url_and_secret(self, table, configured):
        with_secret(table, url=None)
        response = put(CRM_URL, True)

        assert response.status_code == 200
        body = response.json()
        assert (body["url"], body["enabled"], body["secret_set"]) == (CRM_URL, True, True)
        assert "s" * 43 not in response.text
        assert meta(table)["webhook_enabled"] is True

    def test_put_null_url_removes_it_and_disables(self, table, configured):
        with_secret(table, enabled=True)
        response = put(None, False)

        assert response.status_code == 200
        assert response.json()["url"] is None
        assert response.json()["enabled"] is False
        assert "webhook_url" not in meta(table)
        assert meta(table)["webhook_secret"] == "s" * 43  # the secret stays

    @pytest.mark.parametrize(
        ("url", "message"),
        [
            ("http://crm.example.com/hook", "must use https"),
            ("https://user:pw@crm.example.com/hook", "must not contain credentials"),
            ("https://169.254.169.254/latest/meta-data/", "private, loopback, link-local or reserved"),
            ("https://10.0.0.5/hook", "private, loopback, link-local or reserved"),
            ("https://127.0.0.1:8080/hook", "private, loopback, link-local or reserved"),
            ("https://[::1]/hook", "private, loopback, link-local or reserved"),
            ("https://[fd00:ec2::254]/hook", "private, loopback, link-local or reserved"),
            ("https://localhost/hook", "internal name"),
            ("https://2130706433/hook", "dotted-decimal"),
            ("https://crm.example.com/" + "a" * 2030, "at most 2048 characters"),
        ],
    )
    def test_invalid_urls_are_400_and_nothing_is_written(self, table, configured, url, message):
        response = put(url, False)

        assert response.status_code == 400
        assert message in response.json()["detail"]
        assert not table.updates
        assert "webhook_url" not in meta(table)

    def test_body_shape_is_validated(self, table, configured):
        assert client.put(BASE, headers=HEADERS, json={"url": CRM_URL}).status_code == 422
        assert client.put(BASE, headers=HEADERS, json={"url": CRM_URL, "enabled": False, "x": 1}).status_code == 422

    def test_changed_meanwhile_is_409(self, table, configured):
        with_secret(table, url=None)
        with patch("app.routers.integrations.put_webhook_settings", return_value=False):
            response = put(CRM_URL, True)

        assert response.status_code == 409


# ------------------------------------------------------------------ secret
class TestSecret:
    def test_secret_is_returned_once_and_only_flagged_later(self, table, configured):
        response = client.post(f"{BASE}/secret", headers=HEADERS)

        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        secret = response.json()["secret"]
        assert re.fullmatch(r"[A-Za-z0-9_-]{43}", secret)
        assert meta(table)["webhook_secret"] == secret

        got = client.get(BASE, headers=HEADERS)
        assert got.json()["secret_set"] is True
        assert secret not in got.text
        assert secret not in put(CRM_URL, True).text

    def test_new_secret_replaces_the_old_one(self, table, configured):
        first = client.post(f"{BASE}/secret", headers=HEADERS).json()["secret"]
        second = client.post(f"{BASE}/secret", headers=HEADERS).json()["secret"]

        assert first != second
        assert meta(table)["webhook_secret"] == second
        assert {k: v for k, v in meta(table).items() if not k.startswith("webhook_")} == META


# ------------------------------------------------------------------ deliveries
class TestDeliveries:
    def test_last_20_of_the_retention_window_newest_first(self, table, configured):
        now = datetime.now(UTC)
        for n in range(25):
            table.put_item(delivery_item(now - timedelta(hours=n), n))
        table.put_item(delivery_item(now - timedelta(days=8), 99))  # past the window, TTL not run yet
        table.put_item({"PK": f"PROJ#{PROJECT_ID}", "SK": f"FCASK#{_iso(now)}#x", "input_tokens": 1})
        table.put_item({"PK": f"PROJ#{PROJECT_ID}", "SK": "DOC#doc-1", "data": {}})
        table.put_item(delivery_item(now, 7, PK="PROJ#proj_other"))
        table.put_item(
            delivery_item(
                now + timedelta(seconds=1),
                100,
                event="file_check.completed",
                status="failed",
                http_status=Decimal(503),
                error="HTTP 503",
                applicant="Sneha Anil Kulkarni",
                attempts=Decimal(3),
            )
        )

        response = client.get(BASE, headers=HEADERS)

        assert response.status_code == 200
        deliveries = response.json()["deliveries"]
        assert len(deliveries) == 20
        assert [d["delivery_id"] for d in deliveries] == ["d-100"] + [f"d-{n}" for n in range(19)]
        assert deliveries[0] == {
            "delivery_id": "d-100",
            "at": _iso(now + timedelta(seconds=1)),
            "event": "file_check.completed",
            "applicant": "Sneha Anil Kulkarni",
            "status": "failed",
            "http_status": 503,
            "error": "HTTP 503",
        }
        assert deliveries[1]["http_status"] == 200 and deliveries[1]["error"] is None
        (query,) = table.queries
        assert query["ScanIndexForward"] is False and query["Limit"] == 20


# ------------------------------------------------------------------ test event
class TestTestEvent:
    def test_needs_url_and_secret(self, table, configured):
        response = client.post(f"{BASE}/test", headers=HEADERS)

        assert response.status_code == 400
        assert response.json() == {"detail": "Set a webhook URL and generate a signing secret first"}

    def test_not_configured_is_503(self, table, monkeypatch):
        monkeypatch.setattr(get_config(), "webhook_function_name", "")
        with_secret(table)

        response = client.post(f"{BASE}/test", headers=HEADERS)

        assert response.status_code == 503

    def test_sends_through_the_lambda_even_while_disabled(self, table, configured):
        with_secret(table, enabled=False)
        stub = canned_lambda({"delivery_id": "d-1", "status": "delivered", "http_status": 204, "error": None})
        with use_lambda(stub):
            response = client.post(f"{BASE}/test", headers=HEADERS)

        assert response.status_code == 200
        assert response.json() == {"delivery_id": "d-1", "status": "delivered", "http_status": 204, "error": None}
        (call,) = stub.invoke.call_args_list
        assert call.kwargs["FunctionName"] == FUNCTION_NAME
        assert call.kwargs["InvocationType"] == "RequestResponse"
        assert json.loads(call.kwargs["Payload"]) == {"project_id": PROJECT_ID, "event": "test"}

    def test_crm_failure_is_a_failed_result_not_an_error(self, table, configured):
        with_secret(table)
        stub = canned_lambda({"delivery_id": "d-2", "status": "failed", "http_status": 500, "error": "HTTP 500"})
        with use_lambda(stub):
            response = client.post(f"{BASE}/test", headers=HEADERS)

        assert response.status_code == 200
        assert response.json() == {"delivery_id": "d-2", "status": "failed", "http_status": 500, "error": "HTTP 500"}

    @pytest.mark.parametrize(
        ("stub", "status"),
        [
            (canned_lambda({"status": "skipped", "reason": "webhook URL or secret not set"}), 409),
            (canned_lambda({"errorMessage": "boom"}, function_error="Unhandled"), 502),
            (canned_lambda(raw=b"not json"), 502),
            (canned_lambda({"status": "error", "error": "webhook failed: KeyError"}), 502),
            (
                canned_lambda(
                    error=ClientError({"Error": {"Code": "AccessDeniedException", "Message": "no"}}, "Invoke")
                ),
                502,
            ),
        ],
    )
    def test_lambda_problems(self, table, configured, stub, status):
        with_secret(table)
        with use_lambda(stub):
            response = client.post(f"{BASE}/test", headers=HEADERS)

        assert response.status_code == status


# ------------------------------------------------------------------ end to end with the real Lambda
def _load_webhook_lambda():
    if WEBHOOK_DIR not in sys.path:
        sys.path.insert(0, WEBHOOK_DIR)
    path = os.path.join(WEBHOOK_DIR, "index.py")
    spec = importlib.util.spec_from_file_location("webhook_delivery_lambda_index", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class InProcessLambda:
    """boto3 Lambda client stub that runs the real delivery handler."""

    def __init__(self, module):
        self.module = module
        self.calls = []

    def invoke(self, **kwargs):
        self.calls.append(kwargs)
        result = self.module.handler(json.loads(kwargs["Payload"]), None)
        return {"StatusCode": 200, "Payload": io.BytesIO(json.dumps(result).encode("utf-8"))}


def test_end_to_end_test_event_is_signed_and_logged(table, configured, monkeypatch):
    lam = _load_webhook_lambda()
    monkeypatch.setattr(lam, "_table", table)
    monkeypatch.setattr(lam, "_resolve", lambda host, port, type=None: [(2, 1, 6, "", ("93.184.216.34", port))])
    sent = []

    def fake_post(target, addresses, body, headers):
        sent.append((target, addresses, body, headers))
        return 200

    monkeypatch.setattr(lam, "_post_once", fake_post)

    assert put(CRM_URL, False).status_code == 200
    secret = client.post(f"{BASE}/secret", headers=HEADERS).json()["secret"]
    with use_lambda(InProcessLambda(lam)):
        response = client.post(f"{BASE}/test", headers=HEADERS)

    assert response.status_code == 200
    result = response.json()
    assert (result["status"], result["http_status"], result["error"]) == ("delivered", 200, None)

    ((target, addresses, body, headers),) = sent
    assert (target.host, target.port, target.target) == ("crm.example.com", 443, "/hooks/idp?token=abc")
    assert addresses == ["93.184.216.34"]
    assert headers["X-SmartDial-Event"] == "test"
    assert headers["X-SmartDial-Delivery"] == result["delivery_id"]
    assert headers["Content-Type"] == "application/json"
    assert verify_signature(secret, headers["X-SmartDial-Signature"], body)
    payload = json.loads(body)
    assert payload["event"] == "test"
    assert payload["delivery_id"] == result["delivery_id"]
    assert payload["project_id"] == PROJECT_ID
    assert payload["document_id"] is None
    assert payload["results"] == []

    deliveries = client.get(BASE, headers=HEADERS).json()["deliveries"]
    assert deliveries == [
        {
            "delivery_id": result["delivery_id"],
            "at": payload["at"],
            "event": "test",
            "applicant": None,
            "status": "delivered",
            "http_status": 200,
            "error": None,
        }
    ]
    (log_item,) = [i for i in table.puts if i["SK"].startswith("WHDLV#")]
    assert secret not in json.dumps(log_item, default=str)
    assert 7 * 86400 - 60 <= log_item["expires_at"] - int(datetime.now(UTC).timestamp()) <= 7 * 86400
