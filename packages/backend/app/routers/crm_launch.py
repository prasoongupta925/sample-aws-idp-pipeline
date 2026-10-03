"""CRM launch link: settings for admins, and the check the /launch page calls.

GET  /integrations/crm-launch          {secret_set, rotated_at, rotated_by} (admins)
POST /integrations/crm-launch/secret   new launch secret, returned once (admins)
POST /crm-launch/open                  {query}: verify the link, open or create the lead's project

See app/crm_launch.py for the link format and the checks. /crm-launch/open
needs a signed-in user of the app (a user pool identity in the request), as
every page does; the link itself grants nothing more than opening the lead.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from app import crm_launch
from app.cache import cached_query_projects
from app.caller import Caller, current_caller, require_admin
from app.routers.projects import ProjectCreate, create_project, find_project_by_lead
from app.webhook_secret import SecretEncryptionError, SecretKeyNotConfiguredError

router = APIRouter(tags=["integrations"])


class ErrorResponse(BaseModel):
    detail: str


class LaunchSettingsResponse(BaseModel):
    secret_set: bool
    rotated_at: str | None = None
    rotated_by: str | None = None
    max_lifetime_s: int = Field(default=crm_launch.MAX_LIFETIME_S, description="Longest allowed exp - now")


class LaunchSecretResponse(BaseModel):
    secret: str = Field(description="HMAC-SHA256 key of the launch links; store it in the CRM now, not shown again")


class LaunchOpenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(max_length=crm_launch.MAX_QUERY_LENGTH, description="The raw query string of the /launch URL")


class LaunchOpenResponse(BaseModel):
    project_id: str
    created: bool = Field(description="True when the lead had no project yet and one was made")
    crm_lead_id: str


_KMS_ERRORS = {
    502: {"model": ErrorResponse, "description": "The secret could not be encrypted or decrypted (KMS)"},
    503: {"model": ErrorResponse, "description": "The secret key is not configured"},
}


@router.get(
    "/integrations/crm-launch",
    responses={403: {"model": ErrorResponse, "description": "Admins only"}},
    summary="CRM launch link settings (admins)",
)
def get_launch_settings(caller: Annotated[Caller, Depends(require_admin)]) -> LaunchSettingsResponse:
    return LaunchSettingsResponse(**crm_launch.get_settings())


@router.post(
    "/integrations/crm-launch/secret",
    responses={403: {"model": ErrorResponse, "description": "Admins only"}, **_KMS_ERRORS},
    summary="Rotate the CRM launch secret (admins; returned once)",
)
def rotate_launch_secret(caller: Annotated[Caller, Depends(require_admin)], response: Response) -> LaunchSecretResponse:
    """Replaces the secret at once: links signed with the old one stop working."""
    try:
        secret = crm_launch.rotate_secret(caller.username)
    except SecretKeyNotConfiguredError as e:
        raise HTTPException(status_code=503, detail="Launch secret encryption is not configured") from e
    except SecretEncryptionError as e:
        print(f"crm launch secret not stored user={caller.username}: {e}")
        raise HTTPException(status_code=502, detail=f"The launch secret could not be encrypted: {e}") from e
    response.headers["Cache-Control"] = "no-store"
    print(f"crm launch secret rotated user={caller.username}")
    return LaunchSecretResponse(secret=secret)


@router.post(
    "/crm-launch/open",
    responses={
        400: {"model": ErrorResponse, "description": "Malformed, badly signed, expired or already used link"},
        403: {"model": ErrorResponse, "description": "No signed-in user"},
        409: {"model": ErrorResponse, "description": "Launch links are not set up (no secret yet)"},
        **_KMS_ERRORS,
    },
    summary="Verify a CRM launch link and open (or create) the lead's project",
)
async def open_launch_link(
    request: LaunchOpenRequest, caller: Annotated[Caller, Depends(current_caller)]
) -> LaunchOpenResponse:
    try:
        params = crm_launch.parse_query(request.query)
        crm_launch.check_shape(params)
        secret = crm_launch.load_secret()
        launch = crm_launch.verify(params, secret)
        crm_launch.mark_used(launch)
    except crm_launch.LaunchLinkError as e:
        print(f"crm launch refused user={caller.username}: {e}")
        raise HTTPException(status_code=400, detail=str(e)) from e
    except crm_launch.LaunchSecretMissingError as e:
        raise HTTPException(status_code=409, detail="CRM launch links are not set up yet (ask an admin)") from e
    except SecretKeyNotConfiguredError as e:
        raise HTTPException(status_code=503, detail="Launch secret encryption is not configured") from e
    except SecretEncryptionError as e:
        print(f"crm launch secret unreadable: {e}")
        raise HTTPException(status_code=502, detail="The launch secret could not be read") from e

    existing = find_project_by_lead(await cached_query_projects(), launch.lead)
    if existing is not None:
        project_id, created = existing.data.project_id, False
    else:
        description = f"Smart Dial lead {launch.lead}" + (f", phone {launch.phone}" if launch.phone else "")
        project = await create_project(
            ProjectCreate(
                name=launch.name or f"Lead {launch.lead}",
                description=description,
                created_by=caller.username,
                crm_lead_id=launch.lead,
            )
        )
        project_id, created = project.project_id, True
    print(f"crm launch user={caller.username} lead={launch.lead} project={project_id} created={created}")
    return LaunchOpenResponse(project_id=project_id, created=created, crm_lead_id=launch.lead)
