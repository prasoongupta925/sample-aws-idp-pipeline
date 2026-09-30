"""Tests for the webhook delivery Lambda (index.py). No AWS or network calls.

DynamoDB and the file-check Lambda are fakes, DNS resolution and the HTTP POST
are stubbed at the module's seams (_resolve, _post_once), and sleeping is
recorded instead of waited. One test runs the real file-check engine
(packages/lambda/file-check-mcp) in-process. Synthetic data only.

Run (from this folder): python -m pytest -q
"""

import base64
import copy
import http.client
import importlib.util
import io
import json
import os
import socket
import ssl
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

os.environ.setdefault("AWS_DEFAULT_REGION", "ap-south-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ.setdefault("AWS_SESSION_TOKEN", "testing")

HERE = Path(__file__).resolve().parent
REPO_PACKAGES = HERE.parents[3]
FILE_CHECK_DIR = REPO_PACKAGES / "lambda" / "file-check-mcp"
BACKEND_COPY = REPO_PACKAGES / "backend" / "app" / "webhook_security.py"

if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import webhook_security as ws  # noqa: E402


def _load(name, path, env=None):
    previous = {k: os.environ.get(k) for k in env or {}}
    os.environ.update(env or {})
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        for k, v in previous.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return module


wh = _load(
    "webhook_delivery_index",
    HERE / "index.py",
    {"BACKEND_TABLE_NAME": "test-table", "FILE_CHECK_FUNCTION_NAME": "idp-v2-file-check-mcp", "RETENTION_DAYS": "7"},
)

PROJECT_ID = "proj_demo"
SECRET = "whsec-" + "x" * 37
CRM_URL = "https://crm.example.com/hooks/idp?token=t0k3n"
PUBLIC_IP = "93.184.216.34"
NOW = datetime(2026, 9, 30, 10, 0, 0, tzinfo=UTC)


def test_module_is_a_copy_of_the_backend_module():
    assert (HERE / "webhook_security.py").read_bytes() == BACKEND_COPY.read_bytes()


# ------------------------------------------------------------------ fakes
class FakeTable:
    def __init__(self, items=(), fail_put=False):
        self.items = {(i["PK"], i["SK"]): copy.deepcopy(i) for i in items}
        self.gets = []
        self.puts = []
        self.fail_put = fail_put

    def get_item(self, Key, ProjectionExpression=None, ConsistentRead=None):
        self.gets.append({"Key": Key, "ProjectionExpression": ProjectionExpression, "ConsistentRead": ConsistentRead})
        item = self.items.get((Key["PK"], Key["SK"]))
        if item is None:
            return {}
        if ProjectionExpression:
            names = [n.strip() for n in ProjectionExpression.split(",")]
            item = {n: item[n] for n in names if n in item}
        return {"Item": copy.deepcopy(item)}

    def put_item(self, Item):
        if self.fail_put:
            raise RuntimeError("ProvisionedThroughputExceededException")
        self.puts.append(copy.deepcopy(Item))


class FileCheckLambda:
    """boto3 Lambda client stub: answers each invoke with the next canned file check."""

    def __init__(self, *answers, function_error=None):
        self.answers = list(answers)
        self.calls = []
        self.function_error = function_error

    def invoke(self, **kwargs):
        self.calls.append(kwargs)
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        response = {"StatusCode": 200, "Payload": io.BytesIO(json.dumps(answer).encode("utf-8"))}
        if self.function_error:
            response["FunctionError"] = self.function_error
        return response


def meta(enabled=True, url=CRM_URL, secret=SECRET):
    item = {"PK": f"PROJ#{PROJECT_ID}", "SK": "META", "data": {"name": "Demo"}}
    if url is not None:
        item["webhook_url"] = url
    if secret is not None:
        item["webhook_secret"] = secret
    item["webhook_enabled"] = enabled
    return item


def applicant(name, verdict, doc_ids, reasons=(), missing=(), needs_review=()):
    return {
        "applicant": name,
        "pan": "ABCDE1234F",
        "verdict": verdict,
        "documents": [{"document_id": d, "document_name": f"{d}.pdf", "doc_type": "salary_slip"} for d in doc_ids],
        "reasons": list(reasons),
        "missing_items": list(missing),
        "mismatches": [],
        "needs_review": list(needs_review),
        "manual_review": [],
    }


SNEHA = applicant(
    "Sneha Anil Kulkarni",
    "NOT READY",
    ["s-01", "s-02"],
    reasons=[
        "MISSING – Salary slips (last 3 months): Jun 2026 missing",
        "MISMATCH – Declared net salary vs bank salary credits: declared ₹65,000 vs ₹58,000",
    ],
    missing=["Salary slip: Jun 2026"],
    needs_review=["FOIR (indicative): re-run the analysis"],
)
RAHUL = applicant("Rahul Vijay Deshmukh", "READY", ["r-01", "r-02"])


def check(*applicants, pending=(), summary="2 applicants: ...", overall="NOT READY"):
    return {
        "project_id": PROJECT_ID,
        "engine_version": "test",
        "as_of": "2026-09-30",
        "checklist": {"id": "salaried_personal_loan", "name": "Personal Loan - Salaried"},
        "overall_verdict": overall,
        "summary": summary,
        "applicants": list(applicants),
        "pending_documents": [{"document_id": d, "document_name": d, "status": "in_progress"} for d in pending],
        "failed_documents": [],
        "no_facts_documents": [],
        "unsupported_documents": [],
        "unassigned_documents": [],
    }


class Poster:
    """Stub for _post_once: answers each POST with the next scripted status or exception."""

    def __init__(self, *script):
        self.script = list(script)
        self.calls = []

    def __call__(self, target, addresses, body, headers):
        self.calls.append({"target": target, "addresses": addresses, "body": body, "headers": dict(headers)})
        step = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(step, BaseException):
            raise step
        return step


def resolver(*addresses):
    calls = []

    def resolve(host, port, type=None):
        calls.append((host, port))
        return [
            (socket.AF_INET6 if ":" in a else socket.AF_INET, socket.SOCK_STREAM, 6, "", (a, port)) for a in addresses
        ]

    resolve.calls = calls
    return resolve


@pytest.fixture
def env(monkeypatch):
    """Enabled webhook, one READY + one NOT READY applicant, CRM answers 200."""
    state = {
        "table": FakeTable([meta()]),
        "lambda": FileCheckLambda(check(SNEHA, RAHUL)),
        "post": Poster(200),
        "resolve": resolver(PUBLIC_IP),
        "sleeps": [],
    }
    monkeypatch.setattr(wh, "_table", state["table"])
    monkeypatch.setattr(wh, "_lambda_client", state["lambda"])
    monkeypatch.setattr(wh, "_post_once", state["post"])
    monkeypatch.setattr(wh, "_resolve", state["resolve"])
    monkeypatch.setattr(wh, "_sleep", state["sleeps"].append)
    monkeypatch.setattr(wh, "_utcnow", lambda: NOW)
    monkeypatch.setattr(wh, "_time", lambda: 1_790_000_000.5)
    return state


def use(monkeypatch, env, **overrides):
    for key, value in overrides.items():
        env[key] = value
        attr = {"table": "_table", "lambda": "_lambda_client", "post": "_post_once", "resolve": "_resolve"}[key]
        monkeypatch.setattr(wh, attr, value)


def doc_event(document_id="s-01"):
    return {"project_id": PROJECT_ID, "document_id": document_id, "event": "file_check.completed"}


# ------------------------------------------------------------------ success
def test_delivers_signed_payload_for_the_documents_applicant(env, capsys):
    result = wh.handler(doc_event("s-01"), None)

    assert result["status"] == "delivered"
    assert result["http_status"] == 200
    assert result["error"] is None
    (call,) = env["post"].calls
    assert call["target"] == ws.WebhookTarget("crm.example.com", 443, "/hooks/idp?token=t0k3n")
    assert call["addresses"] == [PUBLIC_IP]
    headers, body = call["headers"], call["body"]
    assert headers["Content-Type"] == "application/json"
    assert headers["X-SmartDial-Event"] == "file_check.completed"
    assert headers["X-SmartDial-Delivery"] == result["delivery_id"]
    assert headers["X-SmartDial-Signature"].startswith("t=1790000000,v1=")
    assert ws.verify_signature(SECRET, headers["X-SmartDial-Signature"], body, now=1_790_000_000)

    payload = json.loads(body)
    assert payload == {
        "event": "file_check.completed",
        "delivery_id": result["delivery_id"],
        "project_id": PROJECT_ID,
        "document_id": "s-01",
        "at": "2026-09-30T10:00:00.000000+00:00",
        "results": [
            {
                "applicant": "Sneha Anil Kulkarni",
                "verdict": "NOT READY",
                "summary": (
                    "Sneha Anil Kulkarni NOT READY (2 issues, 1 to review): MISSING – Salary slips (last 3 months); "
                    "MISMATCH – Declared net salary vs bank salary credits"
                ),
                "missing": ["Salary slip: Jun 2026"],
                "checklist_id": "salaried_personal_loan",
            }
        ],
    }

    # The file check was invoked like the backend does.
    (invoke,) = env["lambda"].calls
    assert invoke["FunctionName"] == "idp-v2-file-check-mcp"
    assert invoke["InvocationType"] == "RequestResponse"
    assert json.loads(invoke["Payload"]) == {"project_id": PROJECT_ID}
    custom = json.loads(base64.b64decode(invoke["ClientContext"]))["custom"]
    assert custom == {"bedrockAgentCoreToolName": "filecheck___run_file_check"}

    # META read strongly consistent; one log item with a 7-day TTL.
    assert env["table"].gets[0]["ConsistentRead"] is True
    (item,) = env["table"].puts
    assert item == {
        "PK": f"PROJ#{PROJECT_ID}",
        "SK": f"WHDLV#2026-09-30T10:00:00.000000+00:00#{result['delivery_id']}",
        "delivery_id": result["delivery_id"],
        "at": "2026-09-30T10:00:00.000000+00:00",
        "event": "file_check.completed",
        "status": "delivered",
        "attempts": 1,
        "expires_at": int(NOW.timestamp()) + 7 * 86400,
        "document_id": "s-01",
        "applicant": "Sneha Anil Kulkarni",
        "http_status": 200,
    }

    logs = capsys.readouterr().out
    assert SECRET not in logs
    assert "t0k3n" not in logs and "/hooks/idp" not in logs
    assert "Sneha" not in logs and "salaried_personal_loan" not in logs
    assert "host=crm.example.com" in logs


def test_ready_applicant_summary_has_no_issue_list(env):
    wh.handler(doc_event("r-02"), None)

    (result,) = json.loads(env["post"].calls[0]["body"])["results"]
    assert result == {
        "applicant": "Rahul Vijay Deshmukh",
        "verdict": "READY",
        "summary": "Rahul Vijay Deshmukh READY",
        "missing": [],
        "checklist_id": "salaried_personal_loan",
    }


def test_unknown_document_reports_every_applicant(env):
    wh.handler(doc_event("not-in-any-applicant"), None)

    results = json.loads(env["post"].calls[0]["body"])["results"]
    assert [r["applicant"] for r in results] == ["Sneha Anil Kulkarni", "Rahul Vijay Deshmukh"]
    assert env["table"].puts[0]["applicant"] == "Sneha Anil Kulkarni, Rahul Vijay Deshmukh"


def test_no_applicant_gives_one_project_level_result(env, monkeypatch):
    summary = "No applicant could be identified (1 unassigned document)"
    use(monkeypatch, env, **{"lambda": FileCheckLambda(check(summary=summary))})

    wh.handler(doc_event("u-01"), None)

    assert json.loads(env["post"].calls[0]["body"])["results"] == [
        {
            "applicant": None,
            "verdict": "NOT READY",
            "summary": summary,
            "missing": [],
            "checklist_id": "salaried_personal_loan",
        }
    ]
    assert "applicant" not in env["table"].puts[0]


def test_rechecks_while_the_document_still_shows_pending(env, monkeypatch):
    stale = check(RAHUL, pending=["s-01"])
    use(monkeypatch, env, **{"lambda": FileCheckLambda(stale, check(SNEHA, RAHUL))})

    wh.handler(doc_event("s-01"), None)

    assert len(env["lambda"].calls) == 2
    assert env["sleeps"] == [2]
    (result,) = json.loads(env["post"].calls[0]["body"])["results"]
    assert result["applicant"] == "Sneha Anil Kulkarni"


def test_recheck_is_bounded(env, monkeypatch):
    use(monkeypatch, env, **{"lambda": FileCheckLambda(check(RAHUL, pending=["s-01"]))})

    result = wh.handler(doc_event("s-01"), None)

    assert result["status"] == "delivered"
    assert len(env["lambda"].calls) == 3
    assert env["sleeps"] == [2, 4]


def test_real_engine_results(monkeypatch, env):
    """The real file-check handler and engine produce what build_results expects."""
    monkeypatch.syspath_prepend(str(FILE_CHECK_DIR))
    fc = _load("file_check_mcp_index_for_webhook", FILE_CHECK_DIR / "index.py", {"BACKEND_TABLE_NAME": "test-table"})

    def facts(doc_id, name, doc_type, **fields):
        return {
            "document_id": doc_id,
            "project_id": PROJECT_ID,
            "document_name": name,
            "doc_type": doc_type,
            "fields": fields,
            "grounding": {"grounded": True, "notes": [], "unverified_fields": []},
            "status": "completed",
        }

    n, pan = "Sneha Anil Kulkarni", "CKRPK7314M"
    docs = [
        facts("s-01", "01_loan_application_form.pdf", "loan_application", applicant_name=n, pan=pan),
        facts("s-02", "02_salary_slip_2026-08.pdf", "salary_slip", applicant_name=n, pan=pan, month="2026-08"),
        facts("a-01", "01_amit_application.pdf", "loan_application", applicant_name="Amit Patil", pan="AAAPP1234Q"),
    ]
    items = [{"PK": f"PROJ#{PROJECT_ID}", "SK": "META", "data": {"name": "Demo"}}]
    for f in docs:
        doc = {"document_id": f["document_id"], "name": f["document_name"], "status": "completed"}
        items.append({"PK": f"PROJ#{PROJECT_ID}", "SK": f"DOC#{f['document_id']}", "data": doc})
        items.append({"PK": f"PROJ#{PROJECT_ID}", "SK": f"FACTS#{f['document_id']}", "data": f})

    class QueryTable:
        def query(self, **kwargs):
            return {"Items": items}

    monkeypatch.setattr(fc, "_table", QueryTable())

    class InProcess:
        def invoke(self, **kwargs):
            custom = json.loads(base64.b64decode(kwargs["ClientContext"]))["custom"]
            context = type("Ctx", (), {"client_context": type("CC", (), {"custom": custom})()})()
            out = fc.handler(json.loads(kwargs["Payload"]), context)
            return {"StatusCode": 200, "Payload": io.BytesIO(json.dumps(out).encode("utf-8"))}

    use(monkeypatch, env, **{"lambda": InProcess()})

    result = wh.handler(doc_event("s-02"), None)

    assert result["status"] == "delivered"
    (sneha,) = json.loads(env["post"].calls[0]["body"])["results"]
    assert sneha["applicant"] == "Sneha Anil Kulkarni"
    assert sneha["verdict"] == "NOT READY"
    assert sneha["checklist_id"] == "salaried_personal_loan"
    assert sneha["summary"].startswith("Sneha Anil Kulkarni NOT READY (")
    assert any(m.startswith("Salary slip") for m in sneha["missing"])


# ------------------------------------------------------------------ retries
def test_5xx_is_retried_with_backoff(env, monkeypatch):
    use(monkeypatch, env, post=Poster(500, 502, 204))

    result = wh.handler(doc_event(), None)

    assert (result["status"], result["http_status"], result["error"]) == ("delivered", 204, None)
    assert len(env["post"].calls) == 3
    assert env["sleeps"] == [1, 2]
    assert env["table"].puts[0]["attempts"] == 3
    # Every attempt is signed afresh with the same delivery id and body.
    ids = {c["headers"]["X-SmartDial-Delivery"] for c in env["post"].calls}
    assert ids == {result["delivery_id"]}
    assert len({c["body"] for c in env["post"].calls}) == 1


def test_5xx_on_every_attempt_fails(env, monkeypatch):
    use(monkeypatch, env, post=Poster(503))

    result = wh.handler(doc_event(), None)

    assert (result["status"], result["http_status"], result["error"]) == ("failed", 503, "HTTP 503")
    assert len(env["post"].calls) == 3
    item = env["table"].puts[0]
    assert (item["status"], item["http_status"], item["attempts"], item["error"]) == ("failed", 503, 3, "HTTP 503")


@pytest.mark.parametrize("status", [400, 401, 404, 410, 429])
def test_4xx_is_not_retried(env, monkeypatch, status):
    use(monkeypatch, env, post=Poster(status))

    result = wh.handler(doc_event(), None)

    assert (result["status"], result["http_status"], result["error"]) == ("failed", status, f"HTTP {status}")
    assert len(env["post"].calls) == 1
    assert env["sleeps"] == []


def test_redirect_is_not_followed(env, monkeypatch):
    use(monkeypatch, env, post=Poster(302))

    result = wh.handler(doc_event(), None)

    assert result["status"] == "failed"
    assert result["http_status"] == 302
    assert "redirects are not followed" in result["error"]
    assert len(env["post"].calls) == 1


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (ConnectionRefusedError(111, "Connection refused"), "connection failed (ConnectionRefusedError)"),
        (TimeoutError("timed out"), "timed out after 5 s"),
        (http.client.RemoteDisconnected("closed"), "connection failed (RemoteDisconnected)"),
    ],
)
def test_network_errors_are_retried(env, monkeypatch, error, message):
    use(monkeypatch, env, post=Poster(error))

    result = wh.handler(doc_event(), None)

    assert (result["status"], result["http_status"], result["error"]) == ("failed", None, message)
    assert len(env["post"].calls) == 3


def test_network_error_then_success(env, monkeypatch):
    use(monkeypatch, env, post=Poster(ConnectionResetError(104, "reset"), 200))

    result = wh.handler(doc_event(), None)

    assert result["status"] == "delivered"
    assert len(env["post"].calls) == 2
    assert env["sleeps"] == [1]


def test_certificate_error_is_not_retried(env, monkeypatch):
    use(monkeypatch, env, post=Poster(ssl.SSLCertVerificationError("certificate verify failed")))

    result = wh.handler(doc_event(), None)

    assert result["error"] == "TLS certificate verification failed"
    assert len(env["post"].calls) == 1


def test_dns_failure_is_retried(env, monkeypatch):
    def failing(host, port, type=None):
        raise socket.gaierror(socket.EAI_AGAIN, "Temporary failure in name resolution")

    use(monkeypatch, env, resolve=failing)

    result = wh.handler(doc_event(), None)

    assert (result["status"], result["error"]) == ("failed", "DNS lookup failed")
    assert env["post"].calls == []
    assert env["sleeps"] == [1, 2]


def test_retries_stop_at_the_delivery_budget(env, monkeypatch):
    clock = iter([0.0, 21.0])  # start, then after the first attempt: 21 + 1 + 5 > 25
    monkeypatch.setattr(wh, "_monotonic", lambda: next(clock))
    use(monkeypatch, env, post=Poster(500))

    result = wh.handler(doc_event(), None)

    assert result["status"] == "failed"
    assert len(env["post"].calls) == 1
    assert env["sleeps"] == []


# ------------------------------------------------------------------ blocked
@pytest.mark.parametrize(
    "addresses",
    [
        ("10.0.0.5",),
        ("169.254.169.254",),
        ("127.0.0.1",),
        ("::1",),
        ("fd00:ec2::254",),
        (PUBLIC_IP, "192.168.1.20"),
    ],
)
def test_dns_answer_with_a_private_address_is_blocked(env, monkeypatch, addresses):
    use(monkeypatch, env, resolve=resolver(*addresses))

    result = wh.handler(doc_event(), None)

    assert result["status"] == "failed"
    assert result["http_status"] is None
    assert result["error"] == (
        "blocked: crm.example.com resolves to a private, loopback, link-local or reserved address"
    )
    assert env["post"].calls == []
    assert env["sleeps"] == []
    assert len(env["resolve"].calls) == 1
    assert env["table"].puts[0]["status"] == "failed"


@pytest.mark.parametrize(
    "url",
    ["http://crm.example.com/hook", "https://169.254.169.254/latest/meta-data/", "https://localhost/x"],
)
def test_url_is_checked_again_at_send_time(env, monkeypatch, url):
    use(monkeypatch, env, table=FakeTable([meta(url=url)]))

    result = wh.handler(doc_event(), None)

    assert result["status"] == "failed"
    assert result["error"].startswith("blocked: Webhook URL")
    assert env["resolve"].calls == []
    assert env["post"].calls == []
    assert env["table"].puts[0]["attempts"] == 0


# ------------------------------------------------------------------ skipped / test event
@pytest.mark.parametrize(
    ("item", "reason"),
    [
        (meta(enabled=False), "webhook disabled"),
        (meta(enabled=True, url=None), "webhook URL or secret not set"),
        (meta(enabled=True, secret=None), "webhook URL or secret not set"),
    ],
)
def test_disabled_or_incomplete_makes_no_calls(env, monkeypatch, item, reason):
    use(monkeypatch, env, table=FakeTable([item]))

    result = wh.handler(doc_event(), None)

    assert result == {"status": "skipped", "reason": reason}
    assert env["lambda"].calls == []
    assert env["post"].calls == []
    assert env["resolve"].calls == []
    assert env["table"].puts == []


def test_missing_meta_webhook_fields_count_as_disabled(env, monkeypatch):
    use(monkeypatch, env, table=FakeTable([{"PK": f"PROJ#{PROJECT_ID}", "SK": "META", "data": {}}]))

    assert wh.handler(doc_event(), None) == {"status": "skipped", "reason": "webhook disabled"}
    assert env["post"].calls == []


@pytest.mark.parametrize(
    ("event", "reason"),
    [
        ({"project_id": "proj_missing", "event": "file_check.completed"}, "project not found"),
        ({"project_id": "../x", "event": "test"}, "invalid project_id"),
        ({"event": "test"}, "invalid project_id"),
        ({"project_id": PROJECT_ID, "event": "other"}, "unknown event"),
    ],
)
def test_invalid_input_is_skipped(env, event, reason):
    assert wh.handler(event, None) == {"status": "skipped", "reason": reason}
    assert env["post"].calls == []


def test_test_event_needs_no_enable_and_carries_no_applicant_data(env, monkeypatch):
    use(monkeypatch, env, table=FakeTable([meta(enabled=False)]))

    result = wh.handler({"project_id": PROJECT_ID, "event": "test", "document_id": "s-01"}, None)

    assert result["status"] == "delivered"
    assert env["lambda"].calls == []
    (call,) = env["post"].calls
    assert call["headers"]["X-SmartDial-Event"] == "test"
    payload = json.loads(call["body"])
    assert payload["event"] == "test"
    assert payload["document_id"] is None
    assert payload["results"] == []
    item = env["table"].puts[0]
    assert item["event"] == "test"
    assert "applicant" not in item and "document_id" not in item


def test_file_check_failure_is_logged_as_failed_and_nothing_is_sent(env, monkeypatch):
    use(monkeypatch, env, **{"lambda": FileCheckLambda({"error": "file check failed: KeyError"})})

    result = wh.handler(doc_event(), None)

    assert result["status"] == "failed"
    assert result["error"] == "file check failed: file check failed: KeyError"
    assert env["post"].calls == []
    assert env["table"].puts[0]["attempts"] == 0


def test_file_check_function_error(env, monkeypatch):
    use(monkeypatch, env, **{"lambda": FileCheckLambda({"errorMessage": "x"}, function_error="Unhandled")})

    result = wh.handler(doc_event(), None)

    assert result["error"] == "file check failed: function error (Unhandled)"
    assert env["post"].calls == []


def test_log_write_failure_does_not_fail_the_delivery(env, monkeypatch):
    table = FakeTable([meta()], fail_put=True)
    use(monkeypatch, env, table=table)

    assert wh.handler(doc_event(), None)["status"] == "delivered"


def test_handler_never_raises(env, monkeypatch):
    class Broken:
        def get_item(self, **kwargs):
            raise RuntimeError("AccessDenied")

    use(monkeypatch, env, table=Broken())

    assert wh.handler(doc_event(), None) == {"status": "error", "error": "webhook failed: RuntimeError"}
    assert wh.handler("not a dict", None) == {"status": "skipped", "reason": "invalid project_id"}


# ------------------------------------------------------------------ pinned connection
class RecordingContext:
    def __init__(self):
        self.wrapped = []

    def wrap_socket(self, sock, server_hostname=None):
        self.wrapped.append(server_hostname)
        return sock


class DummySocket:
    def setsockopt(self, *args):
        pass

    def close(self):
        pass


def test_pinned_connection_connects_to_checked_addresses_only(monkeypatch):
    connected = []

    def fake_create_connection(address, timeout=None, source_address=None):
        connected.append((address, timeout))
        if address[0] == "203.0.113.1":
            raise ConnectionRefusedError(111, "refused")
        return DummySocket()

    def no_dns(*args, **kwargs):
        raise AssertionError("the connection must not resolve the host again")

    monkeypatch.setattr(socket, "create_connection", fake_create_connection)
    monkeypatch.setattr(socket, "getaddrinfo", no_dns)
    context = RecordingContext()
    connection = wh.PinnedHTTPSConnection("crm.example.com", 8443, ["203.0.113.1", PUBLIC_IP], 5, context)

    connection.connect()

    assert connected == [(("203.0.113.1", 8443), 5), ((PUBLIC_IP, 8443), 5)]
    assert context.wrapped == ["crm.example.com"]  # SNI and certificate check use the host name


def test_pinned_connection_raises_when_no_address_connects(monkeypatch):
    def refuse(address, timeout=None, source_address=None):
        raise ConnectionRefusedError(111, "refused")

    monkeypatch.setattr(socket, "create_connection", refuse)
    connection = wh.PinnedHTTPSConnection("crm.example.com", 443, [PUBLIC_IP], 5, RecordingContext())

    with pytest.raises(ConnectionRefusedError):
        connection.connect()


def test_post_once_sends_one_post_and_returns_the_status(monkeypatch):
    requests = []

    class FakeConnection:
        def __init__(self, host, port, addresses, timeout, context):
            requests.append({"host": host, "port": port, "addresses": addresses, "timeout": timeout})

        def request(self, method, target, body=None, headers=None):
            requests[-1].update(method=method, target=target, body=body, headers=headers)

        def getresponse(self):
            return type("Response", (), {"status": 201})()

        def close(self):
            requests[-1]["closed"] = True

    monkeypatch.setattr(wh, "PinnedHTTPSConnection", FakeConnection)
    target = ws.WebhookTarget("crm.example.com", 443, "/hooks?x=1")

    assert wh._post_once(target, [PUBLIC_IP], b"{}", {"A": "b"}) == 201
    assert requests == [
        {
            "host": "crm.example.com",
            "port": 443,
            "addresses": [PUBLIC_IP],
            "timeout": 5,
            "method": "POST",
            "target": "/hooks?x=1",
            "body": b"{}",
            "headers": {"A": "b"},
            "closed": True,
        }
    ]
