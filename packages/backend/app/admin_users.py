"""Users of the app's Cognito user pool, for the admin Users page.

Roles are the Cognito groups admin / handler / viewer (app/caller.py). A user
has at most one of them; set_role removes the others. Invites use
AdminCreateUser, so Cognito sends the pool's own invitation email (the clearer
text set in UserIdentity, with the username and temporary password each on
their own line).

The pool signs in with a username or the email address, so a username may not
look like an email address; an invite without a username gets one made from the
local part of the email.

The backend role may call only the cognito-idp admin actions used here, on this
user pool only (ApplicationStack).
"""

import re
from dataclasses import dataclass
from datetime import datetime

from botocore.exceptions import ClientError

from app.caller import ROLE_GROUPS, get_cognito_client, reset_cache
from app.config import get_config

MAX_USERS = 1000
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}$")
NAME_MAX = 100


class AdminUsersError(Exception):
    """A refused request; status is the HTTP status to answer with."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class PoolUser:
    username: str
    email: str | None
    given_name: str | None
    family_name: str | None
    status: str
    enabled: bool
    created_at: str | None
    role: str | None


def _pool_id() -> str:
    pool = get_config().user_pool_id
    if not pool:
        raise AdminUsersError(503, "The user pool is not configured")
    return pool


def _iso(value) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _attrs(user: dict) -> dict[str, str]:
    raw = user.get("Attributes") or user.get("UserAttributes") or []
    return {a["Name"]: a.get("Value", "") for a in raw}


def _error(e: ClientError, action: str) -> AdminUsersError:
    code = e.response.get("Error", {}).get("Code", "")
    if code == "UserNotFoundException":
        return AdminUsersError(404, "No such user")
    if code == "UsernameExistsException":
        return AdminUsersError(409, "A user with this username or email already exists")
    if code in ("InvalidParameterException", "InvalidPasswordException"):
        return AdminUsersError(400, f"Cognito refused the request: {e.response['Error'].get('Message', code)}")
    if code == "NotAuthorizedException":
        return AdminUsersError(409, f"Cognito refused to {action} for this user")
    if code in ("TooManyRequestsException", "LimitExceededException"):
        return AdminUsersError(429, "Too many requests to Cognito; try again shortly")
    print(f"cognito {action} failed: {code}")
    return AdminUsersError(502, f"Cognito could not {action}")


def _roles_by_username(pool: str) -> dict[str, str]:
    """username -> role, from the members of each role group (highest role wins)."""
    client = get_cognito_client()
    roles: dict[str, str] = {}
    for group in reversed(ROLE_GROUPS):  # viewer, handler, admin: admin overwrites
        kwargs = {"UserPoolId": pool, "GroupName": group, "Limit": 60}
        while True:
            page = client.list_users_in_group(**kwargs)
            for user in page.get("Users") or []:
                roles[user["Username"]] = group
            if not page.get("NextToken"):
                break
            kwargs["NextToken"] = page["NextToken"]
    return roles


def _to_user(user: dict, role: str | None) -> PoolUser:
    attrs = _attrs(user)
    return PoolUser(
        username=user["Username"],
        email=attrs.get("email") or None,
        given_name=attrs.get("given_name") or None,
        family_name=attrs.get("family_name") or None,
        status=user.get("UserStatus", "UNKNOWN"),
        enabled=bool(user.get("Enabled", True)),
        created_at=_iso(user.get("UserCreateDate")),
        role=role,
    )


def list_users() -> tuple[list[PoolUser], bool]:
    """All users of the pool (up to MAX_USERS) with their role; the flag says the list was cut."""
    pool = _pool_id()
    client = get_cognito_client()
    try:
        roles = _roles_by_username(pool)
        users: list[dict] = []
        kwargs = {"UserPoolId": pool, "Limit": 60}
        while True:
            page = client.list_users(**kwargs)
            users.extend(page.get("Users") or [])
            if not page.get("PaginationToken") or len(users) >= MAX_USERS:
                break
            kwargs["PaginationToken"] = page["PaginationToken"]
    except ClientError as e:
        raise _error(e, "list the users") from e
    # The loop only stops with a token left when it hit MAX_USERS.
    truncated = len(users) > MAX_USERS or bool(page.get("PaginationToken"))
    result = [_to_user(u, roles.get(u["Username"])) for u in users[:MAX_USERS]]
    result.sort(key=lambda u: u.username)
    return result, truncated


def username_from_email(email: str) -> str:
    local = email.split("@", 1)[0].lower()
    name = re.sub(r"[^a-z0-9._-]+", ".", local).strip("._-")
    return name[:63] if len(name) >= 2 else f"user.{name}".strip(".")


def check_role(role: str) -> str:
    if role not in ROLE_GROUPS:
        raise AdminUsersError(400, f"Role must be one of: {', '.join(ROLE_GROUPS)}")
    return role


def get_user(username: str) -> PoolUser:
    pool = _pool_id()
    client = get_cognito_client()
    try:
        user = client.admin_get_user(UserPoolId=pool, Username=username)
        groups = _groups_of(pool, username)
    except ClientError as e:
        raise _error(e, "read the user") from e
    role = next((g for g in ROLE_GROUPS if g in groups), None)
    return _to_user(user, role)


def user_sub(username: str) -> str | None:
    """The sub of a pool user (AdminGetUser also resolves aliases), lower case, or None."""
    try:
        user = get_cognito_client().admin_get_user(UserPoolId=_pool_id(), Username=username)
    except ClientError as e:
        raise _error(e, "read the user") from e
    sub = _attrs(user).get("sub")
    return sub.lower() if sub else None


def _groups_of(pool: str, username: str) -> list[str]:
    client = get_cognito_client()
    groups: list[str] = []
    kwargs = {"UserPoolId": pool, "Username": username, "Limit": 60}
    while True:
        page = client.admin_list_groups_for_user(**kwargs)
        groups.extend(g["GroupName"] for g in page.get("Groups") or [])
        if not page.get("NextToken"):
            return groups
        kwargs["NextToken"] = page["NextToken"]


def invite(email: str, given_name: str, family_name: str, role: str, username: str | None) -> PoolUser:
    """AdminCreateUser (Cognito emails the invitation with a temporary password), then the role group."""
    pool = _pool_id()
    check_role(role)
    username = (username or username_from_email(email)).lower()
    if not USERNAME_RE.match(username):
        raise AdminUsersError(400, "Username: 2-63 lowercase letters, digits, dot, dash or underscore")
    client = get_cognito_client()
    try:
        client.admin_create_user(
            UserPoolId=pool,
            Username=username,
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "email_verified", "Value": "true"},
                {"Name": "given_name", "Value": given_name},
                {"Name": "family_name", "Value": family_name},
            ],
            DesiredDeliveryMediums=["EMAIL"],
        )
    except ClientError as e:
        raise _error(e, "create the user") from e
    try:
        client.admin_add_user_to_group(UserPoolId=pool, Username=username, GroupName=role)
    except ClientError as e:
        raise _error(e, "set the role (the user was invited without one)") from e
    return get_user(username)


def set_enabled(username: str, enabled: bool) -> PoolUser:
    pool = _pool_id()
    client = get_cognito_client()
    try:
        if enabled:
            client.admin_enable_user(UserPoolId=pool, Username=username)
        else:
            client.admin_disable_user(UserPoolId=pool, Username=username)
            # Also end their sessions: refresh tokens stop working (issued AWS
            # credentials still run out on their own, within the hour).
            client.admin_user_global_sign_out(UserPoolId=pool, Username=username)
    except ClientError as e:
        raise _error(e, "enable the user" if enabled else "disable the user") from e
    return get_user(username)


def reset_password(username: str) -> str:
    """Users who never signed in get their invitation again (new temporary password); others a reset code.

    Returns "invite_resent" or "reset_code_sent".
    """
    user = get_user(username)
    pool = _pool_id()
    client = get_cognito_client()
    try:
        if user.status == "FORCE_CHANGE_PASSWORD":
            client.admin_create_user(
                UserPoolId=pool, Username=username, MessageAction="RESEND", DesiredDeliveryMediums=["EMAIL"]
            )
            return "invite_resent"
        client.admin_reset_user_password(UserPoolId=pool, Username=username)
        return "reset_code_sent"
    except ClientError as e:
        raise _error(e, "reset the password") from e


def set_role(username: str, role: str) -> PoolUser:
    """Puts the user in exactly one role group (adds the new one first, so they never have none)."""
    pool = _pool_id()
    check_role(role)
    client = get_cognito_client()
    try:
        current = _groups_of(pool, username)
        if role not in current:
            client.admin_add_user_to_group(UserPoolId=pool, Username=username, GroupName=role)
        for other in ROLE_GROUPS:
            if other != role and other in current:
                client.admin_remove_user_from_group(UserPoolId=pool, Username=username, GroupName=other)
    except ClientError as e:
        raise _error(e, "set the role") from e
    # This instance forgets cached roles at once; other instances within caller.CACHE_TTL_S.
    reset_cache()
    return get_user(username)
