"""Storage of the customer upload links (see app/upload_links.py).

Items:
- the link, by token hash (the only way the public endpoints find it):
    PK = ULINK#{token_hash}, SK = LINK
  link_id, project_id, items, language, dsa_name, status, file_count,
  max_files, created_by, created_at, expires_at_iso, consented_at,
  submitted_at, and expires_at (epoch seconds, DynamoDB TTL);
- a pointer in the project's partition, for the staff list and revoke:
    PK = PROJ#{project_id}, SK = ULINK#{link_id}
  link_id, token_hash, created_at, expires_at (TTL);
- one consent record per Accept:
    PK = ULINK#{token_hash}, SK = CONSENT#{iso timestamp}
  link_id, project_id, consented_at, user_agent, language, consent_version,
  expires_at (TTL: the retention period).

Every reader of the project partition selects its own SK prefix (DOC#,
FACTS#, FCASK#, ...), so the ULINK# pointers are ignored there; deleting the
project deletes them with it. Nothing here holds the token itself.
"""

from decimal import Decimal
from typing import Any

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from app.ddb.client import get_table

LINK_PK_PREFIX = "ULINK#"
LINK_SK = "LINK"
POINTER_SK_PREFIX = "ULINK#"
CONSENT_SK_PREFIX = "CONSENT#"


def _link_key(token_hash: str) -> dict[str, str]:
    return {"PK": f"{LINK_PK_PREFIX}{token_hash}", "SK": LINK_SK}


def _pointer_key(project_id: str, link_id: str) -> dict[str, str]:
    return {"PK": f"PROJ#{project_id}", "SK": f"{POINTER_SK_PREFIX}{link_id}"}


def _plain(value: Any) -> Any:
    """DynamoDB numbers come back as Decimal: make them int (or float)."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    return value


def _conditional_failed(error: ClientError) -> bool:
    return error.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"


def put_link(token_hash: str, link: dict[str, Any]) -> None:
    """Store a new link and its project pointer."""
    table = get_table()
    table.put_item(
        Item={**_link_key(token_hash), **link},
        ConditionExpression="attribute_not_exists(PK)",
    )
    table.put_item(
        Item={
            **_pointer_key(link["project_id"], link["link_id"]),
            "link_id": link["link_id"],
            "token_hash": token_hash,
            "created_at": link["created_at"],
            "expires_at": link["expires_at"],
        }
    )


def get_link(token_hash: str) -> dict[str, Any] | None:
    item = get_table().get_item(Key=_link_key(token_hash)).get("Item")
    return _plain(item) if item else None


def get_pointer(project_id: str, link_id: str) -> dict[str, Any] | None:
    item = get_table().get_item(Key=_pointer_key(project_id, link_id)).get("Item")
    return _plain(item) if item else None


def query_pointers(project_id: str) -> list[dict[str, Any]]:
    """The project's link pointers (one page is plenty: links expire within 7 days)."""
    response = get_table().query(
        KeyConditionExpression=Key("PK").eq(f"PROJ#{project_id}") & Key("SK").begins_with(POINTER_SK_PREFIX),
    )
    return [_plain(item) for item in response.get("Items", [])]


def reserve_file_slot(token_hash: str, *, now_epoch: int) -> int | None:
    """Count one more file on an active, consented, unexpired link with room left.

    Returns the new count, or None when the link is not in that state (the
    condition is checked atomically, so parallel calls cannot pass the limit).
    """
    try:
        response = get_table().update_item(
            Key=_link_key(token_hash),
            UpdateExpression="SET file_count = file_count + :one",
            ConditionExpression=(
                "attribute_exists(PK) AND #status = :active AND expires_at > :now "
                "AND file_count < max_files AND attribute_exists(consented_at)"
            ),
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":one": 1, ":active": "active", ":now": now_epoch},
            ReturnValues="UPDATED_NEW",
        )
    except ClientError as e:
        if _conditional_failed(e):
            return None
        raise
    return int(response["Attributes"]["file_count"])


def record_consent(
    token_hash: str,
    *,
    link_id: str,
    project_id: str,
    consented_at: str,
    user_agent: str,
    language: str,
    consent_version: str,
    expires_at: int,
) -> None:
    """Log one consent and mark the link consented (first consent time kept)."""
    table = get_table()
    table.put_item(
        Item={
            "PK": f"{LINK_PK_PREFIX}{token_hash}",
            "SK": f"{CONSENT_SK_PREFIX}{consented_at}",
            "link_id": link_id,
            "project_id": project_id,
            "consented_at": consented_at,
            "user_agent": user_agent,
            "language": language,
            "consent_version": consent_version,
            "expires_at": expires_at,
        }
    )
    table.update_item(
        Key=_link_key(token_hash),
        UpdateExpression="SET consented_at = if_not_exists(consented_at, :at)",
        ConditionExpression="attribute_exists(PK)",
        ExpressionAttributeValues={":at": consented_at},
    )


def close_link(token_hash: str, status: str, *, at: str) -> bool:
    """active -> submitted / revoked. False when the link is not active (any more)."""
    try:
        get_table().update_item(
            Key=_link_key(token_hash),
            UpdateExpression="SET #status = :status, closed_at = :at",
            ConditionExpression="attribute_exists(PK) AND #status = :active",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":status": status, ":at": at, ":active": "active"},
        )
    except ClientError as e:
        if _conditional_failed(e):
            return False
        raise
    return True


def count_unlock_attempt(project_id: str, document_id: str, *, max_attempts: int) -> bool:
    """Count one password attempt on a document; False once max_attempts were used."""
    try:
        get_table().update_item(
            Key={"PK": f"PROJ#{project_id}", "SK": f"DOC#{document_id}"},
            UpdateExpression="SET #data.unlock_attempts = if_not_exists(#data.unlock_attempts, :zero) + :one",
            ConditionExpression=(
                "attribute_exists(PK) AND (attribute_not_exists(#data.unlock_attempts) OR #data.unlock_attempts < :max)"
            ),
            ExpressionAttributeNames={"#data": "data"},
            ExpressionAttributeValues={":zero": 0, ":one": 1, ":max": max_attempts},
        )
    except ClientError as e:
        if _conditional_failed(e):
            return False
        raise
    return True


def set_document_fields(project_id: str, document_id: str, fields: dict[str, Any]) -> None:
    """SET data.<name> = value for each field (leaves the rest of the document as is)."""
    names = {"#data": "data"}
    values: dict[str, Any] = {}
    parts = []
    for i, (name, value) in enumerate(fields.items()):
        names[f"#f{i}"] = name
        values[f":v{i}"] = value
        parts.append(f"#data.#f{i} = :v{i}")
    get_table().update_item(
        Key={"PK": f"PROJ#{project_id}", "SK": f"DOC#{document_id}"},
        UpdateExpression="SET " + ", ".join(parts),
        ConditionExpression="attribute_exists(PK)",
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def set_document_status_if(project_id: str, document_id: str, *, status: str, expected: str) -> bool:
    """data.status = status only while it is still `expected` (the pipeline may have moved on)."""
    try:
        get_table().update_item(
            Key={"PK": f"PROJ#{project_id}", "SK": f"DOC#{document_id}"},
            UpdateExpression="SET #data.#status = :status",
            ConditionExpression="#data.#status = :expected",
            ExpressionAttributeNames={"#data": "data", "#status": "status"},
            ExpressionAttributeValues={":status": status, ":expected": expected},
        )
    except ClientError as e:
        if _conditional_failed(e):
            return False
        raise
    return True
