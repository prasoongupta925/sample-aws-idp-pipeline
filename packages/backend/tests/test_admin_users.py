"""Admin Users page API (app/admin_users.py, app/routers/admin_users.py).

No AWS calls: Cognito is an in-memory fake user pool with the three role groups.
The caller's identity comes from the API Gateway request context, as in
test_crm_launch; the x-user-id header (spoofed here) never counts.
"""

from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

from app import admin_users
from app.config import get_config
from app.main import app
from tests.test_crm_launch import ADMIN_SUB, HANDLER_SUB, OTHER_POOL_SUB, POOL, context_header

client = TestClient(app)

ADMIN = context_header(ADMIN_SUB)
HANDLER = context_header(HANDLER_SUB)
OTHER_POOL = context_header(OTHER_POOL_SUB, pool="ap-south-1_OTHER")


def _err(code: str, op: str):
    return ClientError({"Error": {"Code": code, "Message": code}}, op)


class FakePool:
    """Users keyed by username, plus group membership; records every mutating call."""

    def __init__(self):
        created = datetime(2026, 9, 1, tzinfo=UTC)
        self.users = {
            "asha.verma": {"sub": ADMIN_SUB, "email": "asha@example.com", "status": "CONFIRMED", "enabled": True},
            "rohan.iyer": {"sub": HANDLER_SUB, "email": "rohan@example.com", "status": "CONFIRMED", "enabled": True},
            "new.joiner": {"sub": "x", "email": "new@example.com", "status": "FORCE_CHANGE_PASSWORD", "enabled": True},
        }
        self.groups = {"admin": {"asha.verma"}, "handler": {"rohan.iyer"}, "viewer": set()}
        self.created = created
        self.calls: list[tuple] = []
        self.page_size = 2

    def _user(self, name):
        if name not in self.users:
            raise _err("UserNotFoundException", "AdminGetUser")
        return self.users[name]

    def _shape(self, name, key="Attributes"):
        u = self.users[name]
        return {
            "Username": name,
            key: [{"Name": "email", "Value": u["email"]}, {"Name": "sub", "Value": u["sub"]}]
            + [{"Name": k, "Value": u[k]} for k in ("given_name", "family_name") if k in u],
            "UserStatus": u["status"],
            "Enabled": u["enabled"],
            "UserCreateDate": self.created,
        }

    # -- reads (also used by app/caller.py)
    def list_users(self, UserPoolId, Limit, Filter=None, PaginationToken=None):
        assert UserPoolId == POOL
        names = sorted(self.users)
        if Filter:
            sub = Filter.split('"')[1]
            return {"Users": [{"Username": n} for n in names if self.users[n]["sub"] == sub][:1]}
        start = int(PaginationToken or 0)
        page = names[start : start + self.page_size]
        out = {"Users": [self._shape(n) for n in page]}
        if start + self.page_size < len(names):
            out["PaginationToken"] = str(start + self.page_size)
        return out

    def list_users_in_group(self, UserPoolId, GroupName, Limit, NextToken=None):
        assert UserPoolId == POOL
        return {"Users": [{"Username": n} for n in sorted(self.groups[GroupName])]}

    def admin_list_groups_for_user(self, UserPoolId, Username, Limit, NextToken=None):
        self._user(Username)
        return {"Groups": [{"GroupName": g} for g, members in self.groups.items() if Username in members]}

    def admin_get_user(self, UserPoolId, Username):
        self._user(Username)
        return self._shape(Username, key="UserAttributes")

    # -- writes
    def admin_create_user(self, UserPoolId, Username, DesiredDeliveryMediums, UserAttributes=None, MessageAction=None):
        assert UserPoolId == POOL
        self.calls.append(("create", Username, MessageAction))
        if MessageAction == "RESEND":
            self._user(Username)
            return {}
        if Username in self.users or any(
            a["Value"] == u["email"] for u in self.users.values() for a in UserAttributes if a["Name"] == "email"
        ):
            raise _err("UsernameExistsException", "AdminCreateUser")
        attrs = {a["Name"]: a["Value"] for a in UserAttributes}
        assert attrs["email_verified"] == "true"
        self.users[Username] = {
            "sub": "new",
            "email": attrs["email"],
            "given_name": attrs["given_name"],
            "family_name": attrs["family_name"],
            "status": "FORCE_CHANGE_PASSWORD",
            "enabled": True,
        }
        return {}

    def admin_add_user_to_group(self, UserPoolId, Username, GroupName):
        self._user(Username)
        self.calls.append(("add", Username, GroupName))
        self.groups[GroupName].add(Username)

    def admin_remove_user_from_group(self, UserPoolId, Username, GroupName):
        self.calls.append(("remove", Username, GroupName))
        self.groups[GroupName].discard(Username)

    def admin_disable_user(self, UserPoolId, Username):
        self._user(Username)["enabled"] = False
        self.calls.append(("disable", Username))

    def admin_enable_user(self, UserPoolId, Username):
        self._user(Username)["enabled"] = True
        self.calls.append(("enable", Username))

    def admin_user_global_sign_out(self, UserPoolId, Username):
        self.calls.append(("signout", Username))

    def admin_reset_user_password(self, UserPoolId, Username):
        self._user(Username)
        self.calls.append(("reset", Username))


@pytest.fixture
def pool(monkeypatch):
    monkeypatch.setattr(get_config(), "user_pool_id", POOL)
    fake = FakePool()
    with (
        patch("app.caller.get_cognito_client", return_value=fake),
        patch("app.admin_users.get_cognito_client", return_value=fake),
    ):
        yield fake


# ------------------------------------------------------------------ access
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("get", "/admin/users", None),
        ("post", "/admin/users", {"email": "a@example.com", "given_name": "A", "family_name": "B"}),
        ("post", "/admin/users/new.joiner/disable", None),
        ("post", "/admin/users/new.joiner/enable", None),
        ("post", "/admin/users/new.joiner/reset-password", None),
        ("put", "/admin/users/new.joiner/role", {"role": "viewer"}),
    ],
)
@pytest.mark.parametrize("headers", [HANDLER, OTHER_POOL, {"x-user-id": "asha.verma"}])
def test_every_route_is_admin_only(pool, method, path, body, headers):
    response = getattr(client, method)(path, headers=headers, **({"json": body} if body else {}))
    assert response.status_code == 403
    assert not pool.calls


# ------------------------------------------------------------------ list
def test_lists_all_pages_with_roles_and_status(pool):
    response = client.get("/admin/users", headers=ADMIN)
    assert response.status_code == 200
    body = response.json()
    assert body["truncated"] is False
    users = {u["username"]: u for u in body["users"]}
    assert list(users) == ["asha.verma", "new.joiner", "rohan.iyer"]
    assert users["asha.verma"]["role"] == "admin"
    assert users["rohan.iyer"]["role"] == "handler"
    assert users["new.joiner"]["role"] is None
    assert users["new.joiner"]["status"] == "FORCE_CHANGE_PASSWORD"
    assert users["asha.verma"]["email"] == "asha@example.com"
    assert users["asha.verma"]["created_at"].startswith("2026-09-01")


def test_highest_role_wins_when_in_two_groups(pool):
    pool.groups["viewer"].add("asha.verma")
    users = {u["username"]: u for u in client.get("/admin/users", headers=ADMIN).json()["users"]}
    assert users["asha.verma"]["role"] == "admin"


def test_list_is_capped(pool, monkeypatch):
    monkeypatch.setattr(admin_users, "MAX_USERS", 2)
    body = client.get("/admin/users", headers=ADMIN).json()
    assert body["truncated"] is True
    assert len(body["users"]) == 2


def test_missing_pool_config(pool, monkeypatch):
    monkeypatch.setattr(get_config(), "user_pool_id", "")
    with pytest.raises(admin_users.AdminUsersError) as e:
        admin_users.list_users()
    assert e.value.status == 503
    # Without a pool no caller can be resolved, so the API refuses before that.
    assert client.get("/admin/users", headers=ADMIN).status_code == 403


# ------------------------------------------------------------------ invite
def test_invite_creates_the_user_with_the_pool_email_and_role(pool):
    response = client.post(
        "/admin/users",
        headers=ADMIN,
        json={"email": " Priya.Nair@Example.com ", "given_name": "Priya", "family_name": "Nair", "role": "viewer"},
    )
    assert response.status_code == 201, response.text
    user = response.json()
    assert user["username"] == "priya.nair"
    assert user["role"] == "viewer"
    assert user["status"] == "FORCE_CHANGE_PASSWORD"
    # No MessageAction: Cognito sends the pool's invitation email (temporary password).
    assert ("create", "priya.nair", None) in pool.calls
    assert ("add", "priya.nair", "viewer") in pool.calls


def test_invite_defaults_to_handler_and_takes_a_username(pool):
    response = client.post(
        "/admin/users",
        headers=ADMIN,
        json={"email": "p@example.com", "given_name": "P", "family_name": "N", "username": "Priya_N"},
    )
    assert response.status_code == 201
    assert response.json()["username"] == "priya_n"
    assert response.json()["role"] == "handler"


@pytest.mark.parametrize(
    "body",
    [
        {"email": "not-an-email", "given_name": "A", "family_name": "B"},
        {"email": "a@example.com", "given_name": "", "family_name": "B"},
        {"email": "a@example.com", "given_name": "A", "family_name": "B", "role": "owner"},
        {"email": "a@example.com", "given_name": "A", "family_name": "B", "username": "a@b.com"},
        {"email": "a@example.com", "given_name": "A", "family_name": "B", "extra": 1},
    ],
)
def test_invite_rejects_bad_input(pool, body):
    assert client.post("/admin/users", headers=ADMIN, json=body).status_code in (400, 422)
    assert not [c for c in pool.calls if c[0] == "create"]


def test_invite_of_an_existing_email_is_409(pool):
    response = client.post(
        "/admin/users", headers=ADMIN, json={"email": "rohan@example.com", "given_name": "R", "family_name": "I"}
    )
    assert response.status_code == 409


@pytest.mark.parametrize(
    ("email", "username"),
    [
        ("asha.verma@x.in", "asha.verma"),
        ("A+B@x.in", "a.b"),
        ("x@x.in", "user.x"),
        ("Rohan--Iyer_@x.in", "rohan--iyer"),
    ],
)
def test_username_from_email(email, username):
    assert admin_users.username_from_email(email) == username


# ------------------------------------------------------------------ disable / enable
def test_disable_signs_out_and_enable_restores(pool):
    response = client.post("/admin/users/rohan.iyer/disable", headers=ADMIN)
    assert response.status_code == 200
    assert response.json()["enabled"] is False
    assert pool.calls == [("disable", "rohan.iyer"), ("signout", "rohan.iyer")]
    response = client.post("/admin/users/rohan.iyer/enable", headers=ADMIN)
    assert response.json()["enabled"] is True


def test_admin_cannot_disable_or_demote_themselves(pool):
    assert client.post("/admin/users/Asha.Verma/disable", headers=ADMIN).status_code == 409
    assert client.put("/admin/users/asha.verma/role", headers=ADMIN, json={"role": "viewer"}).status_code == 409
    assert not pool.calls


def test_self_check_compares_the_sub_not_only_the_username(pool):
    # A name that Cognito resolves to the caller (an alias): AdminGetUser answers with the same user.
    real_get = pool.admin_get_user
    pool.admin_get_user = lambda UserPoolId, Username: real_get(
        UserPoolId, "asha.verma" if Username == "asha.alias" else Username
    )
    assert client.post("/admin/users/asha.alias/disable", headers=ADMIN).status_code == 409
    assert client.put("/admin/users/asha.alias/role", headers=ADMIN, json={"role": "viewer"}).status_code == 409
    assert not pool.calls


def test_unknown_user_is_404(pool):
    assert client.post("/admin/users/nobody/disable", headers=ADMIN).status_code == 404
    assert client.post("/admin/users/nobody/reset-password", headers=ADMIN).status_code == 404


def test_bad_username_in_path_is_422(pool):
    assert client.post("/admin/users/a%20b/enable", headers=ADMIN).status_code == 422


# ------------------------------------------------------------------ reset password
def test_reset_sends_a_code_to_a_confirmed_user(pool):
    response = client.post("/admin/users/rohan.iyer/reset-password", headers=ADMIN)
    assert response.json() == {"result": "reset_code_sent"}
    assert pool.calls == [("reset", "rohan.iyer")]


def test_reset_resends_the_invite_to_a_user_who_never_signed_in(pool):
    response = client.post("/admin/users/new.joiner/reset-password", headers=ADMIN)
    assert response.json() == {"result": "invite_resent"}
    assert pool.calls == [("create", "new.joiner", "RESEND")]


# ------------------------------------------------------------------ role
def test_set_role_moves_the_user_to_exactly_one_group(pool):
    pool.groups["viewer"].add("rohan.iyer")
    response = client.put("/admin/users/rohan.iyer/role", headers=ADMIN, json={"role": "admin"})
    assert response.status_code == 200
    assert response.json()["role"] == "admin"
    assert pool.calls[0] == ("add", "rohan.iyer", "admin")  # added before the others are removed
    assert {g for g, m in pool.groups.items() if "rohan.iyer" in m} == {"admin"}


def test_promotion_takes_effect_for_the_promoted_user_at_once(pool):
    assert client.get("/admin/users", headers=HANDLER).status_code == 403  # cached as handler
    client.put("/admin/users/rohan.iyer/role", headers=ADMIN, json={"role": "admin"})
    assert client.get("/admin/users", headers=HANDLER).status_code == 200


def test_set_role_rejects_unknown_roles(pool):
    assert client.put("/admin/users/rohan.iyer/role", headers=ADMIN, json={"role": "root"}).status_code == 422


def test_cognito_throttling_is_429(pool, monkeypatch):
    def throttled(**kwargs):
        raise _err("TooManyRequestsException", "AdminEnableUser")

    monkeypatch.setattr(pool, "admin_enable_user", throttled)
    assert client.post("/admin/users/rohan.iyer/enable", headers=ADMIN).status_code == 429
