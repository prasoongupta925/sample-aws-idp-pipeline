import contextlib
from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from app.cache import CacheKey, cached_query_projects, invalidate
from app.config import get_config
from app.ddb import (
    Project,
    ProjectData,
    batch_delete_items,
    generate_project_id,
    get_project_item,
    now_iso,
    put_project_item,
    query_all_project_items,
    update_project_data,
)
from app.ddb.documents import query_documents
from app.ddb.upload_links import revoke_project_links
from app.ddb.workflows import delete_workflow_item, query_workflows
from app.lancedb import (
    DeleteGraphKeywordsByProjectIdInput,
    DropTableInput,
    LanceDbError,
)
from app.lancedb import delete_graph_keywords_by_project_id as lancedb_delete_graph_keywords
from app.lancedb import drop_table as lancedb_drop_table
from app.s3 import delete_s3_prefix
from app.safe_ids import is_safe_segment
from app.upload_links import STATUS_REVOKED

router = APIRouter(prefix="/projects", tags=["projects"])

# A CRM lead id (Smart Dial or any CRM): letters, digits and . _ : - only, so it is safe
# to log, to put in a URL and to compare. "" in an update removes it.
CRM_LEAD_ID_PATTERN = r"^[A-Za-z0-9._:-]{1,64}$"
CrmLeadId = Annotated[
    str | None,
    Field(
        default=None,
        pattern=CRM_LEAD_ID_PATTERN,
        description="The CRM lead this project belongs to (1-64 of A-Z a-z 0-9 . _ : -); sent in every webhook",
    ),
]
CrmLeadIdUpdate = Annotated[
    str | None,
    Field(
        default=None,
        pattern=r"^$|" + CRM_LEAD_ID_PATTERN,
        description='New CRM lead id; "" removes it, null (or absent) keeps it',
    ),
]


def find_project_by_lead(projects: list[Project], crm_lead_id: str, exclude: str | None = None) -> Project | None:
    """The most recently updated project with this CRM lead id (other than `exclude`), or None."""
    matches = [p for p in projects if p.data.crm_lead_id == crm_lead_id and p.data.project_id != exclude]
    return max(matches, key=lambda p: p.updated_at or p.created_at, default=None)


async def _require_free_lead(crm_lead_id: str | None, project_id: str | None = None) -> None:
    """409 when another project already has this lead id (a lead opens exactly one project)."""
    if not crm_lead_id:
        return
    other = find_project_by_lead(await cached_query_projects(), crm_lead_id, exclude=project_id)
    if other is not None:
        raise HTTPException(
            status_code=409,
            detail=f"CRM lead {crm_lead_id} is already linked to the project {other.data.name!r}",
        )


class WorkflowSummary(BaseModel):
    workflow_id: str
    status: str
    file_name: str
    file_uri: str
    language: str | None = None
    created_at: str
    updated_at: str


class DocumentWorkflows(BaseModel):
    document_id: str
    document_name: str
    workflows: list[WorkflowSummary]


class ProjectCreate(BaseModel):
    name: str
    description: str | None = ""
    created_by: str | None = None
    language: str | None = None
    color: int | None = None
    document_prompt: str | None = None
    ocr_model: str | None = None
    ocr_options: dict[str, Any] | None = None
    crm_lead_id: CrmLeadId = None


class DeletedInfo(BaseModel):
    project_id: str
    workflow_count: int = 0
    lancedb_objects_deleted: int = 0
    lancedb_error: str | None = None
    workflow_items_deleted: int = 0
    s3_objects_deleted: int = 0
    session_objects_deleted: int = 0
    agent_objects_deleted: int = 0
    project_items_deleted: int = 0
    upload_links_revoked: int = 0


class DeleteProjectResponse(BaseModel):
    message: str
    details: DeletedInfo


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    language: str | None = None
    color: int | None = None
    document_prompt: str | None = None
    ocr_model: str | None = None
    ocr_options: dict[str, Any] | None = None
    crm_lead_id: CrmLeadIdUpdate = None


class ProjectResponse(BaseModel):
    project_id: str
    name: str
    description: str
    status: str
    created_by: str | None = None
    language: str | None = None
    color: int | None = None
    document_prompt: str | None = None
    ocr_model: str | None = None
    ocr_options: dict[str, Any] | None = None
    crm_lead_id: str | None = None
    created_at: str
    updated_at: str | None = None

    @staticmethod
    def from_project(project: Project) -> "ProjectResponse":
        return ProjectResponse(
            project_id=project.data.project_id,
            name=project.data.name,
            description=project.data.description,
            status=project.data.status,
            created_by=project.data.created_by,
            language=project.data.language,
            color=project.data.color,
            document_prompt=project.data.document_prompt,
            ocr_model=project.data.ocr_model,
            ocr_options=project.data.ocr_options,
            crm_lead_id=project.data.crm_lead_id,
            created_at=project.created_at,
            updated_at=project.updated_at,
        )


@router.get("")
async def list_projects() -> list[ProjectResponse]:
    projects = await cached_query_projects()
    return [ProjectResponse.from_project(p) for p in projects]


@router.get("/{project_id}/workflows")
def list_project_workflows(project_id: str) -> list[DocumentWorkflows]:
    """List all workflows for all documents in a project."""
    project = get_project_item(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    documents = query_documents(project_id)
    result = []

    for doc in documents:
        document_id = doc.data.document_id
        workflows = query_workflows(document_id)

        workflow_summaries = [
            WorkflowSummary(
                workflow_id=wf.SK.replace("WF#", "") if wf.SK.startswith("WF#") else wf.SK,
                status=wf.data.status,
                file_name=wf.data.file_name,
                file_uri=wf.data.file_uri,
                language=wf.data.language,
                created_at=wf.created_at,
                updated_at=wf.updated_at,
            )
            for wf in workflows
        ]

        result.append(
            DocumentWorkflows(
                document_id=document_id,
                document_name=doc.data.name,
                workflows=workflow_summaries,
            )
        )

    return result


@router.get("/{project_id}")
def get_project(project_id: str) -> ProjectResponse:
    project = get_project_item(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    return ProjectResponse.from_project(project)


@router.post("")
async def create_project(request: ProjectCreate) -> ProjectResponse:
    await _require_free_lead(request.crm_lead_id)
    project_id = generate_project_id()

    now = now_iso()
    data = ProjectData(
        project_id=project_id,
        name=request.name,
        description=request.description or "",
        status="active",
        created_by=request.created_by,
        language=request.language,
        color=request.color,
        document_prompt=request.document_prompt,
        ocr_model=request.ocr_model,
        ocr_options=request.ocr_options,
        crm_lead_id=request.crm_lead_id,
    )

    put_project_item(project_id, data)
    await invalidate(CacheKey.QUERY_PROJECTS)

    return ProjectResponse(
        project_id=project_id,
        name=request.name,
        description=request.description or "",
        status="active",
        created_by=request.created_by,
        language=request.language,
        color=request.color,
        document_prompt=request.document_prompt,
        ocr_model=request.ocr_model,
        ocr_options=request.ocr_options,
        crm_lead_id=request.crm_lead_id,
        created_at=now,
        updated_at=now,
    )


@router.put("/{project_id}")
async def update_project(project_id: str, request: ProjectUpdate) -> ProjectResponse:
    existing = get_project_item(project_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Project not found")

    data = existing.data.model_copy()
    if request.name is not None:
        data.name = request.name
    if request.description is not None:
        data.description = request.description
    if request.language is not None:
        data.language = request.language
    if request.color is not None:
        data.color = request.color
    if request.document_prompt is not None:
        data.document_prompt = request.document_prompt
    if request.ocr_model is not None:
        data.ocr_model = request.ocr_model
    if request.ocr_options is not None:
        data.ocr_options = request.ocr_options
    if request.crm_lead_id is not None and request.crm_lead_id != (data.crm_lead_id or ""):
        await _require_free_lead(request.crm_lead_id, project_id)
        data.crm_lead_id = request.crm_lead_id or None

    update_project_data(project_id, data)
    await invalidate(CacheKey.QUERY_PROJECTS)

    return get_project(project_id)


def _revoke_upload_links(project_id: str) -> int:
    """Revoke every active upload link of the project; how many were closed.

    A failure is logged and the deletion goes on: the public endpoints also
    refuse a link whose project no longer exists.
    """
    try:
        return revoke_project_links(project_id, STATUS_REVOKED, at=now_iso())
    except Exception as e:  # the project is deleted anyway
        print(f"project delete: upload links not revoked project={project_id} ({type(e).__name__})")
        return 0


@router.delete("/{project_id}")
async def delete_project(project_id: str, user_id: str = Header(alias="x-user-id")) -> DeleteProjectResponse:
    """Delete a project and all related data (documents, workflows, S3, LanceDB, sessions)."""
    config = get_config()

    existing = get_project_item(project_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Project not found")

    deleted_info = DeletedInfo(project_id=project_id)

    # 0. Close the project's customer upload links first. Each link lives in its
    # own ULINK#<token hash> partition, so deleting the project's items would
    # leave the customer's page able to add files to the deleted project.
    deleted_info.upload_links_revoked = _revoke_upload_links(project_id)

    # 1. Get all items under this project
    project_items = query_all_project_items(project_id)

    # Extract document IDs and collect workflow IDs
    document_ids = [item["SK"].replace("DOC#", "") for item in project_items if item["SK"].startswith("DOC#")]
    workflow_ids = []
    workflow_items = []
    for doc_id in document_ids:
        wf_items = query_workflows(doc_id)
        for wf in wf_items:
            workflow_ids.append(wf.SK.replace("WF#", ""))
            workflow_items.append({"PK": wf.PK, "SK": wf.SK, "document_id": doc_id})

    deleted_info.workflow_count = len(workflow_ids)

    # 2. Delete from LanceDB via Lambda
    try:
        lancedb_drop_table(DropTableInput(project_id=project_id))
        lancedb_delete_graph_keywords(DeleteGraphKeywordsByProjectIdInput(project_id=project_id))
        # Per-project dataset catalog table is named "{project_id}_datasets".
        lancedb_drop_table(DropTableInput(project_id=f"{project_id}_datasets"))
        deleted_info.lancedb_objects_deleted = 1
    except LanceDbError as e:
        deleted_info.lancedb_error = str(e)

    # 3. Delete workflow items from DynamoDB (including STEP, SEG#*, etc.)
    total_wf_deleted = 0
    for wf_info in workflow_items:
        doc_id = wf_info["document_id"]
        wf_id = wf_info["SK"].replace("WF#", "")
        with contextlib.suppress(Exception):
            total_wf_deleted += delete_workflow_item(doc_id, wf_id)
    deleted_info.workflow_items_deleted = total_wf_deleted

    # 4. Delete from S3 - entire project folder
    project_prefix = f"projects/{project_id}/"
    with contextlib.suppress(Exception):
        s3_deleted = delete_s3_prefix(config.document_storage_bucket_name, project_prefix)
        deleted_info.s3_objects_deleted = s3_deleted

    # 5. Delete session files from S3
    if config.session_storage_bucket_name and user_id and is_safe_segment(user_id):
        session_prefix = f"sessions/{user_id}/{project_id}/"
        with contextlib.suppress(Exception):
            session_deleted = delete_s3_prefix(config.session_storage_bucket_name, session_prefix)
            deleted_info.session_objects_deleted = session_deleted

    # 6. Delete agent files from S3
    if config.agent_storage_bucket_name:
        agent_prefix = f"{user_id}/{project_id}/agents/"
        with contextlib.suppress(Exception):
            agent_deleted = delete_s3_prefix(config.agent_storage_bucket_name, agent_prefix)
            deleted_info.agent_objects_deleted = agent_deleted

    # 7. Delete all project items from DynamoDB (PROJ#, DOC#*, WF#* links)
    batch_delete_items(project_items)

    deleted_info.project_items_deleted = len(project_items)

    await invalidate(CacheKey.QUERY_PROJECTS)
    return DeleteProjectResponse(message=f"Project {project_id} deleted", details=deleted_info)
