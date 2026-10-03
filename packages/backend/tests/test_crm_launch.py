"""CRM launch link (app/crm_launch.py, app/routers/crm_launch.py) and the caller roles (app/caller.py).

No AWS calls: DynamoDB is an in-memory fake (projects, the launch settings item and the
replay items, with attribute_not_exists conditions), KMS a fake whose ciphertexts only
decrypt with the context they were made with, and Cognito a fake user pool with groups.
"""

import base64
import copy
import json
import time
from unittest.mock import patch
from urllib.parse import urlencode

import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

from app import caller as caller_mod
from app import crm_launch
from app.config import get_config
from app.main import app
from tests.test_crm_lead import FakeProjectsTable

client = TestClient(app)

POOL = "ap-south-1_TESTPOOL"
ADMIN_SUB = "11111111-2222-3333-4444-555555555555"
HANDLER_SUB = "66666666-7777-8888-9999-000000000000"
OTHER_POOL_SUB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def context_header(sub: str, pool: str = POOL) -> dict[str, str]:
    provider = f"cognito-idp.ap-south-1.amazonaws.com/{pool}"
    context = {
        "authorizer": {
            "iam": {"cognitoIdentity": {"amr": ["authenticated", provider, f"{provider}:CognitoSignIn:{sub}"]}}
        }
    }
    return {"x-amzn-request-context": json.dumps(context), "x-user-id": "spoofed-admin"}


ADMIN = context_header(ADMIN_SUB)
HANDLER = context_header(HANDLER_SUB)


class FakeTable(FakeProjectsTable):
    """Projects (from test_crm_lead) plus conditional puts for the launch items."""

    def put_item(self, Item, ConditionExpression=None):
        key = (Item["PK"], Item["SK"])
        if ConditionExpression == "attribute_not_exists(PK)" and key in self.items:
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "PutItem")
        self.items[key] = copy.deepcopy(Item)


class FakeKms:
    def __init__(self):
        self.calls = []

    def encrypt(self, KeyId, Plaintext, EncryptionContext):
        self.calls.append(("encrypt", EncryptionContext))
        blob = json.dumps({"k": KeyId, "c": EncryptionContext, "p": Plaintext.decode()}).encode()
        return {"CiphertextBlob": blob[::-1]}

    def decrypt(self, CiphertextBlob, EncryptionContext):
        self.calls.append(("decrypt", EncryptionContext))
        data = json.loads(CiphertextBlob[::-1])
        if data["c"] != EncryptionContext:
            raise ClientError({"Error": {"Code": "InvalidCiphertextException"}}, "Decrypt")
        return {"Plaintext": data["p"].encode()}


class FakeCognito:
    def __init__(self):
        self.users = {ADMIN_SUB: ("asha.verma", ["admin"]), HANDLER_SUB: ("rohan.iyer", ["handler"])}
        self.lookups = 0

    def list_users(self, UserPoolId, Filter, Limit):
        assert UserPoolId == POOL
        self.lookups += 1
        sub = Filter.split('"')[1]
        user = self.users.get(sub)
        return {"Users": [{"Username": user[0]}] if user else []}

    def admin_list_groups_for_user(self, UserPoolId, Username, Limit, NextToken=None):
        groups = next(g for u, g in self.users.values() if u == Username)
        return {"Groups": [{"GroupName": g} for g in groups]}


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setattr(get_config(), "user_pool_id", POOL)
    monkeypatch.setattr(get_config(), "webhook_secret_key_arn", "arn:aws:kms:ap-south-1:000000000000:key/test")
    table, kms, cognito = FakeTable(), FakeKms(), FakeCognito()
    with (
        patch("app.ddb.projects.get_table", return_value=table),
        patch("app.crm_launch.get_table", return_value=table),
        patch("app.crm_launch.get_kms_client", return_value=kms),
        patch("app.caller.get_cognito_client", return_value=cognito),
    ):
        yield table, kms, cognito


def rotate() -> str:
    response = client.post("/integrations/crm-launch/secret", headers=ADMIN)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()["secret"]


def link(secret: str, **overrides) -> str:
    params = {
        "lead": "SD-LEAD-0042",
        "name": "Asha Verma",
        "phone": "+91 98765 43210",
        "exp": str(int(time.time()) + 120),
    }
    params.update(overrides)
    params = {k: v for k, v in params.items() if v is not None}
    params["sig"] = crm_launch.sign(secret, params)
    return "?" + urlencode(params)


def open_link(query: str, headers=HANDLER):
    return client.post("/crm-launch/open", json={"query": query}, headers=headers)


# ------------------------------------------------------------------ signing (hand-checked)
def test_canonical_query_sorts_encodes_and_drops_sig():
    params = {"phone": "+91 98765", "lead": "L-1", "name": "Asha Verma ~ R&D", "exp": "1700000000", "sig": "x"}
    assert crm_launch.canonical_query(params) == (
        "exp=1700000000&lead=L-1&name=Asha%20Verma%20~%20R%26D&phone=%2B91%2098765"
    )


def test_sign_matches_a_known_vector():
    # python3 -c "import hmac,hashlib;print(hmac.new(b'k',b'exp=1&lead=L',hashlib.sha256).hexdigest())"
    assert crm_launch.sign("k", {"lead": "L", "exp": "1", "sig": "ignored"}) == (
        "0bd62a71924efdb73901ca27a0ddc1ef8fd25569aa874e290c8fb4fcd9b4b922"
    )


def test_link_made_by_the_documented_php_and_js_code_verifies():
    # Output of the PHP and JavaScript functions in docs/crm-launch-link.md (secret "test-secret").
    query = (
        "exp=1790000000&lead=SD-LEAD-0042&name=Asha%20Verma%20%28R%26D%29%21&phone=%2B91%2098765%2043210"
        "&sig=0da5048b94ac4e075aa76525f1e978f812528117ffb3ef69bd5f376ca83ba702"
    )
    launch = crm_launch.verify(crm_launch.parse_query(query), "test-secret", now=1_789_999_900)
    assert (launch.lead, launch.name, launch.phone) == ("SD-LEAD-0042", "Asha Verma (R&D)!", "+91 98765 43210")


def test_plus_and_percent_20_are_the_same_space():
    secret = "s"
    params = {"lead": "L", "name": "Asha Verma", "exp": str(int(time.time()) + 60)}
    sig = crm_launch.sign(secret, params)
    for encoded in ("Asha+Verma", "Asha%20Verma"):
        parsed = crm_launch.parse_query(f"lead=L&name={encoded}&exp={params['exp']}&sig={sig}")
        assert crm_launch.verify(parsed, secret).name == "Asha Verma"


@pytest.mark.parametrize(
    ("query", "reason"),
    [
        ("lead=L&exp=1&sig=a&evil=1", "Unknown"),
        ("lead=L&lead=M&exp=1&sig=a", "repeats"),
        ("lead=L&exp", "malformed"),
    ],
)
def test_parse_query_refuses(query, reason):
    with pytest.raises(crm_launch.LaunchLinkError, match=reason):
        crm_launch.parse_query(query)


def test_verify_expiry_window():
    now = 1_700_000_000.0
    ok = {"lead": "L", "exp": str(int(now) + 300)}
    assert crm_launch.verify({**ok, "sig": crm_launch.sign("s", ok)}, "s", now=now).exp == int(now) + 300
    for exp, reason in ((int(now), "expired"), (int(now) - 10, "expired"), (int(now) + 400, "more than 5 minutes")):
        p = {"lead": "L", "exp": str(exp)}
        with pytest.raises(crm_launch.LaunchLinkError, match=reason):
            crm_launch.verify({**p, "sig": crm_launch.sign("s", p)}, "s", now=now)


def test_verify_refuses_a_wrong_or_tampered_signature():
    now = time.time()
    p = {"lead": "L", "exp": str(int(now) + 60)}
    sig = crm_launch.sign("s", p)
    with pytest.raises(crm_launch.LaunchLinkError, match="signature"):
        crm_launch.verify({**p, "sig": sig}, "other-secret")
    with pytest.raises(crm_launch.LaunchLinkError, match="signature"):
        crm_launch.verify({**p, "lead": "M", "sig": sig}, "s")


@pytest.mark.parametrize(
    "bad",
    [{"lead": "a b"}, {"lead": ""}, {"exp": "soon"}, {"sig": "ABC"}, {"phone": "call me"}, {"name": "x\ny"}],
)
def test_check_shape_refuses(bad):
    params = {"lead": "L", "exp": "1", "sig": "0" * 64, **bad}
    with pytest.raises(crm_launch.LaunchLinkError):
        crm_launch.check_shape(params)


# ------------------------------------------------------------------ caller roles
def test_user_pool_sub_only_trusts_this_pool():
    assert caller_mod.user_pool_sub(ADMIN["x-amzn-request-context"], POOL) == ADMIN_SUB
    other = context_header(OTHER_POOL_SUB, pool="ap-south-1_OTHER")["x-amzn-request-context"]
    assert caller_mod.user_pool_sub(other, POOL) is None
    assert caller_mod.user_pool_sub(None, POOL) is None
    assert caller_mod.user_pool_sub("not json", POOL) is None
    assert caller_mod.user_pool_sub(json.dumps({"authorizer": {}}), POOL) is None
    assert caller_mod.user_pool_sub(ADMIN["x-amzn-request-context"], "") is None


def test_groups_are_cached(env):
    _, _, cognito = env
    assert caller_mod.resolve_caller(ADMIN["x-amzn-request-context"]).is_admin
    assert caller_mod.resolve_caller(ADMIN["x-amzn-request-context"]).username == "asha.verma"
    assert cognito.lookups == 1


# ------------------------------------------------------------------ settings API (admins only)
def test_settings_need_an_admin(env):
    assert client.get("/integrations/crm-launch", headers=HANDLER).status_code == 403
    assert client.post("/integrations/crm-launch/secret", headers=HANDLER).status_code == 403
    # x-user-id alone (no verified identity) is not enough
    assert client.post("/integrations/crm-launch/secret", headers={"x-user-id": "admin"}).status_code == 403


def test_rotate_stores_only_ciphertext_with_the_launch_context(env):
    table, kms, _ = env
    assert client.get("/integrations/crm-launch", headers=ADMIN).json()["secret_set"] is False
    secret = rotate()
    item = table.items[("CRM#smartdial", "LAUNCH")]
    assert secret not in json.dumps(item)
    assert secret not in base64.b64decode(item["secret_enc"]).decode()  # reversed, not plain
    assert kms.calls == [("encrypt", {"crm": "smartdial", "purpose": "crm-launch-secret"})]
    body = client.get("/integrations/crm-launch", headers=ADMIN).json()
    assert body["secret_set"] is True and body["rotated_by"] == "asha.verma" and body["max_lifetime_s"] == 300
    assert "secret" not in body


def test_rotate_without_key_is_503(env, monkeypatch):
    monkeypatch.setattr(get_config(), "webhook_secret_key_arn", "")
    assert client.post("/integrations/crm-launch/secret", headers=ADMIN).status_code == 503


# ------------------------------------------------------------------ open
def test_open_creates_the_project_then_reopens_it(env):
    table, _, _ = env
    secret = rotate()
    first = open_link(link(secret))
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["created"] is True and body["crm_lead_id"] == "SD-LEAD-0042"
    project = client.get(f"/projects/{body['project_id']}").json()
    assert project["name"] == "Asha Verma"
    assert project["crm_lead_id"] == "SD-LEAD-0042"
    assert "+91 98765 43210" in project["description"]

    second = open_link(link(secret, exp=str(int(time.time()) + 100)))
    assert second.status_code == 200
    assert second.json() == {**body, "created": False}
    assert len([k for k in table.items if k[0].startswith("PROJ#")]) == 1


def test_open_uses_an_existing_project_of_the_lead(env):
    secret = rotate()
    existing = client.post("/projects", json={"name": "Rohan Iyer file", "crm_lead_id": "SD-LEAD-7"}).json()
    response = open_link(link(secret, lead="SD-LEAD-7", name="Rohan Iyer"))
    assert response.json() == {"project_id": existing["project_id"], "created": False, "crm_lead_id": "SD-LEAD-7"}


def test_open_refuses_replay(env):
    secret = rotate()
    query = link(secret)
    assert open_link(query).status_code == 200
    again = open_link(query)
    assert again.status_code == 400
    assert "already used" in again.json()["detail"]


def test_replay_item_expires(env):
    table, _, _ = env
    secret = rotate()
    exp = int(time.time()) + 120
    open_link(link(secret, exp=str(exp)))
    used = [v for k, v in table.items.items() if k[0].startswith("LAUNCH#")]
    assert len(used) == 1 and used[0]["expires_at"] == exp + 3600


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"exp": str(int(time.time()) - 5)}, "expired"),
        ({"exp": str(int(time.time()) + 3600)}, "more than 5 minutes"),
    ],
)
def test_open_refuses_bad_expiry(env, overrides, reason):
    secret = rotate()
    response = open_link(link(secret, **overrides))
    assert response.status_code == 400 and reason in response.json()["detail"]


def test_open_refuses_old_secret_after_rotation(env):
    old = rotate()
    rotate()
    response = open_link(link(old))
    assert response.status_code == 400 and "signature" in response.json()["detail"]


def test_open_refuses_tampering(env):
    secret = rotate()
    query = link(secret).replace("SD-LEAD-0042", "SD-LEAD-0043")
    assert open_link(query).status_code == 400


def test_open_without_secret_is_409(env):
    response = open_link(link("whatever"))
    assert response.status_code == 409


def test_open_needs_a_signed_in_user(env):
    secret = rotate()
    assert open_link(link(secret), headers={"x-user-id": "rohan"}).status_code == 403
    unknown = context_header("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    assert open_link(link(secret), headers=unknown).status_code == 403


def test_open_refuses_extra_fields(env):
    response = client.post("/crm-launch/open", json={"query": "", "project_id": "x"}, headers=HANDLER)
    assert response.status_code == 422
