"""Client for the PDF unlock Lambda (WorkflowStack, idp-v2-pdf-unlock).

A password-protected PDF from a customer link waits under the document's
``locked/`` key (app/upload_links.document_keys). The Lambda opens it with the
password, writes an unprotected copy to the document's normal key (which
starts the pipeline) and deletes every version of the protected one.

The password travels only in this synchronous invoke's payload: it is never
stored, and neither this module nor the Lambda logs it (Lambda does not log
payloads). Errors carry a status word, never the payload.
"""

import json

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError

from app.config import get_config

STATUS_UNLOCKED = "unlocked"
STATUS_WRONG_PASSWORD = "wrong_password"

_lambda_client = None


class PdfUnlockNotConfiguredError(Exception):
    """PDF_UNLOCK_FUNCTION_NAME is not set."""


class PdfUnlockServiceError(Exception):
    """The Lambda could not be invoked, failed, or could not read the file."""


def get_pdf_unlock_lambda_client():
    global _lambda_client
    if _lambda_client is None:
        _lambda_client = boto3.client(
            "lambda",
            region_name=get_config().aws_region,
            # The function times out after 60 s. No retry: a retried call would
            # count as a second password attempt for nothing.
            config=BotoConfig(connect_timeout=5, read_timeout=70, retries={"max_attempts": 1, "mode": "standard"}),
        )
    return _lambda_client


def unlock_pdf(source_key: str, target_key: str, password: str) -> dict:
    """Unlock one PDF. Returns {"status": "unlocked", "size": n} or {"status": "wrong_password"}.

    Raises PdfUnlockNotConfiguredError or PdfUnlockServiceError.
    """
    config = get_config()
    if not config.pdf_unlock_function_name:
        raise PdfUnlockNotConfiguredError("pdf unlock function is not configured")
    try:
        resp = get_pdf_unlock_lambda_client().invoke(
            FunctionName=config.pdf_unlock_function_name,
            InvocationType="RequestResponse",
            Payload=json.dumps({"source_key": source_key, "target_key": target_key, "password": password}).encode(
                "utf-8"
            ),
        )
        raw = resp["Payload"].read()
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code") or "ClientError"
        raise PdfUnlockServiceError(f"invoke failed ({code})") from None
    except BotoCoreError as e:
        raise PdfUnlockServiceError(f"invoke failed ({type(e).__name__})") from None

    if resp.get("FunctionError"):
        raise PdfUnlockServiceError(f"function error ({resp['FunctionError']})")
    try:
        payload = json.loads(raw)
    except ValueError:
        raise PdfUnlockServiceError("non-JSON response") from None
    status = payload.get("status") if isinstance(payload, dict) else None
    if status == STATUS_UNLOCKED:
        return {"status": status, "size": int(payload.get("size") or 0)}
    if status == STATUS_WRONG_PASSWORD:
        return {"status": status}
    raise PdfUnlockServiceError(f"unlock failed ({status or 'unknown'})")
