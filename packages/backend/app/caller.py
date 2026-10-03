"""Who is calling, and is that user an admin (Cognito group "admin").

The API is authenticated with AWS IAM (SigV4) at API Gateway: the web app signs
with the Cognito Identity Pool credentials of the signed-in user. The Lambda
Web Adapter passes the API Gateway request context in the
x-amzn-request-context header; for such a caller its
authorizer.iam.cognitoIdentity.amr list holds
"cognito-idp.<region>.amazonaws.com/<user pool id>:CognitoSignIn:<sub>", which
API Gateway sets from the verified credentials, so the sub can be trusted. The
x-user-id header cannot (the browser sets it) and is only an audit label.

Roles are Cognito groups of the user pool (admin, handler, viewer). The groups
of a sub are read with ListUsers (filter sub = ...) and AdminListGroupsForUser,
and kept for CACHE_TTL_S in this process. A caller without a user pool
identity (another AWS role, or no request context) is never an admin.
"""

import json
import re
import threading
import time
from dataclasses import dataclass
from typing import Annotated

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import Depends, Header, HTTPException

from app.config import get_config

ADMIN_GROUP = "admin"
ROLE_GROUPS = ("admin", "handler", "viewer")
CACHE_TTL_S = 60

_SUB_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
_cognito_client = None
_cache: dict[str, tuple[float, "Caller"]] = {}
_cache_lock = threading.Lock()


@dataclass(frozen=True)
class Caller:
    sub: str
    username: str
    groups: tuple[str, ...]

    @property
    def is_admin(self) -> bool:
        return ADMIN_GROUP in self.groups


def get_cognito_client():
    global _cognito_client
    if _cognito_client is None:
        _cognito_client = boto3.client(
            "cognito-idp",
            region_name=get_config().aws_region,
            config=BotoConfig(connect_timeout=5, read_timeout=10, retries={"max_attempts": 3, "mode": "standard"}),
        )
    return _cognito_client


def reset_cache() -> None:
    with _cache_lock:
        _cache.clear()


def user_pool_sub(request_context: str | None, user_pool_id: str) -> str | None:
    """The user pool sub API Gateway verified for this request, or None.

    Only an amr entry of *this* user pool counts (provider ".../<pool id>:CognitoSignIn:<sub>").
    """
    if not request_context or not user_pool_id:
        return None
    try:
        context = json.loads(request_context)
        amr = context["authorizer"]["iam"]["cognitoIdentity"]["amr"]
    except (ValueError, KeyError, TypeError):
        return None
    if not isinstance(amr, list):
        return None
    suffix = f"/{user_pool_id}:CognitoSignIn:"
    for entry in amr:
        if isinstance(entry, str) and entry.startswith("cognito-idp.") and suffix in entry:
            sub = entry.rpartition(":CognitoSignIn:")[2]
            if _SUB_RE.match(sub):
                return sub.lower()
    return None


def _lookup(sub: str, user_pool_id: str) -> Caller | None:
    client = get_cognito_client()
    users = client.list_users(UserPoolId=user_pool_id, Filter=f'sub = "{sub}"', Limit=1).get("Users") or []
    if not users:
        return None
    username = users[0]["Username"]
    groups: list[str] = []
    kwargs = {"UserPoolId": user_pool_id, "Username": username, "Limit": 60}
    while True:
        page = client.admin_list_groups_for_user(**kwargs)
        groups.extend(g["GroupName"] for g in page.get("Groups") or [])
        if not page.get("NextToken"):
            break
        kwargs["NextToken"] = page["NextToken"]
    return Caller(sub=sub, username=username, groups=tuple(sorted(groups)))


def resolve_caller(request_context: str | None) -> Caller | None:
    """The signed-in user pool user behind this request (with their groups), or None."""
    user_pool_id = get_config().user_pool_id
    sub = user_pool_sub(request_context, user_pool_id)
    if sub is None:
        return None
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(sub)
        if hit and hit[0] > now:
            return hit[1]
    try:
        caller = _lookup(sub, user_pool_id)
    except (ClientError, BotoCoreError) as e:
        print(f"caller lookup failed sub={sub}: {type(e).__name__}")
        raise HTTPException(status_code=503, detail="Could not check your role; try again") from e
    if caller is not None:
        with _cache_lock:
            _cache[sub] = (now + CACHE_TTL_S, caller)
    return caller


RequestContext = Annotated[str | None, Header(alias="x-amzn-request-context", include_in_schema=False)]


def current_caller(request_context: RequestContext = None) -> Caller:
    """Dependency: the signed-in user; 403 when the request has no user pool identity."""
    caller = resolve_caller(request_context)
    if caller is None:
        raise HTTPException(status_code=403, detail="This needs a signed-in user of the app")
    return caller


def require_admin(caller: Annotated[Caller, Depends(current_caller)]) -> Caller:
    """Dependency: the signed-in user, who must be in the Cognito group "admin" (403 otherwise)."""
    if not caller.is_admin:
        raise HTTPException(status_code=403, detail="Only admins can do this")
    return caller
