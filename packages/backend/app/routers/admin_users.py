"""Admin Users page: the Cognito users of the app's pool (admins only).

GET  /admin/users                              users with role, status, enabled
POST /admin/users                              invite {email, given_name, family_name, role, username?}
POST /admin/users/{username}/disable           disable (and sign out everywhere)
POST /admin/users/{username}/enable            enable
POST /admin/users/{username}/reset-password    reset code, or the invite again if never signed in
PUT  /admin/users/{username}/role              {role}: admin / handler / viewer

Every route needs a caller in the Cognito group "admin" (app/caller.py); the
web app hiding the page is only a convenience. Admins cannot disable
themselves or change their own role, so the last admin cannot lock everyone out
by accident.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app import admin_users
from app.caller import Caller, require_admin

router = APIRouter(prefix="/admin/users", tags=["admin"])

Role = Literal["admin", "handler", "viewer"]
UsernamePath = Annotated[str, Path(min_length=1, max_length=128, pattern=r"^[\w.@+-]+$")]


class ErrorResponse(BaseModel):
    detail: str


class UserResponse(BaseModel):
    username: str
    email: str | None = None
    given_name: str | None = None
    family_name: str | None = None
    status: str = Field(description="Cognito UserStatus, e.g. CONFIRMED or FORCE_CHANGE_PASSWORD")
    enabled: bool
    created_at: str | None = None
    role: Role | None = None


class UserListResponse(BaseModel):
    users: list[UserResponse]
    truncated: bool = Field(description=f"True when the pool has more than {admin_users.MAX_USERS} users")


class InviteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    email: EmailStr
    given_name: str = Field(min_length=1, max_length=admin_users.NAME_MAX)
    family_name: str = Field(min_length=1, max_length=admin_users.NAME_MAX)
    role: Role = "handler"
    username: str | None = Field(default=None, max_length=63, description="Made from the email when left out")


class RoleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Role


class ResetResponse(BaseModel):
    result: Literal["reset_code_sent", "invite_resent"]


_ERRORS = {
    400: {"model": ErrorResponse, "description": "Invalid request"},
    403: {"model": ErrorResponse, "description": "Admins only"},
    404: {"model": ErrorResponse, "description": "No such user"},
    409: {"model": ErrorResponse, "description": "Conflict (exists, own account, or Cognito refused)"},
    502: {"model": ErrorResponse, "description": "Cognito error"},
}


def _out(user: admin_users.PoolUser) -> UserResponse:
    return UserResponse(**user.__dict__)


def _not_self(caller: Caller, username: str, what: str) -> None:
    """409 when the target is the caller: by username, and by sub (an alias resolves to the same user)."""
    own = HTTPException(status_code=409, detail=f"You cannot {what} your own account; ask another admin")
    if username.lower() == caller.username.lower():
        raise own
    try:
        target_sub = admin_users.user_sub(username)
    except admin_users.AdminUsersError:
        return  # unknown user: the action itself answers (404)
    if target_sub and caller.sub and target_sub == caller.sub.lower():
        raise own


def _call(fn, *args):
    try:
        return fn(*args)
    except admin_users.AdminUsersError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from e


@router.get("", responses=_ERRORS, summary="List the users of the pool (admins)")
def list_users(caller: Annotated[Caller, Depends(require_admin)]) -> UserListResponse:
    users, truncated = _call(admin_users.list_users)
    return UserListResponse(users=[_out(u) for u in users], truncated=truncated)


@router.post("", status_code=201, responses=_ERRORS, summary="Invite a user (admins)")
def invite_user(request: InviteRequest, caller: Annotated[Caller, Depends(require_admin)]) -> UserResponse:
    user = _call(
        admin_users.invite, request.email, request.given_name, request.family_name, request.role, request.username
    )
    print(f"admin users: {caller.username} invited {user.username} role={request.role}")
    return _out(user)


@router.post("/{username}/disable", responses=_ERRORS, summary="Disable a user (admins)")
def disable_user(username: UsernamePath, caller: Annotated[Caller, Depends(require_admin)]) -> UserResponse:
    _not_self(caller, username, "disable")
    user = _call(admin_users.set_enabled, username, False)
    print(f"admin users: {caller.username} disabled {username}")
    return _out(user)


@router.post("/{username}/enable", responses=_ERRORS, summary="Enable a user (admins)")
def enable_user(username: UsernamePath, caller: Annotated[Caller, Depends(require_admin)]) -> UserResponse:
    user = _call(admin_users.set_enabled, username, True)
    print(f"admin users: {caller.username} enabled {username}")
    return _out(user)


@router.post("/{username}/reset-password", responses=_ERRORS, summary="Reset a user's password (admins)")
def reset_password(username: UsernamePath, caller: Annotated[Caller, Depends(require_admin)]) -> ResetResponse:
    result = _call(admin_users.reset_password, username)
    print(f"admin users: {caller.username} reset password of {username}: {result}")
    return ResetResponse(result=result)


@router.put("/{username}/role", responses=_ERRORS, summary="Set a user's role (admins)")
def set_role(
    username: UsernamePath, request: RoleRequest, caller: Annotated[Caller, Depends(require_admin)]
) -> UserResponse:
    _not_self(caller, username, "change the role of")
    user = _call(admin_users.set_role, username, request.role)
    print(f"admin users: {caller.username} set role of {username} to {request.role}")
    return _out(user)
