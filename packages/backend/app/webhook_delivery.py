"""Client for the webhook delivery Lambda (idp-v2-webhook-delivery, WebhookStack).

POST /projects/{id}/integrations/webhook/test invokes it synchronously with
{"project_id": ..., "event": "test"}; the Lambda signs and sends the test event,
records the delivery and answers {delivery_id, status, http_status, error}.
Document deliveries (event file_check.completed) are queued by the workflow
finalizer with an asynchronous invoke, never by the backend.
"""

import json
from typing import Any

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import BotoCoreError, ClientError

from app.config import get_config

EVENT_TEST = "test"

_lambda_client = None


class WebhookNotConfiguredError(Exception):
    """WEBHOOK_FUNCTION_NAME is not set."""


class WebhookServiceError(Exception):
    """The Lambda could not be invoked, failed, or answered unexpectedly."""


class WebhookSkippedError(Exception):
    """The Lambda sent nothing (for example no URL or secret); the message says why."""


def get_webhook_lambda_client():
    global _lambda_client
    if _lambda_client is None:
        config = get_config()
        # One delivery takes at most ~25 s (3 attempts of 5 s plus backoff).
        # No client retries: a retried invoke would send the test event twice.
        _lambda_client = boto3.client(
            "lambda",
            region_name=config.aws_region,
            config=BotoConfig(connect_timeout=5, read_timeout=35, retries={"max_attempts": 1, "mode": "standard"}),
        )
    return _lambda_client


def send_test_event(project_id: str) -> dict[str, Any]:
    """Send a signed test event now; returns {delivery_id, status, http_status, error}."""
    config = get_config()
    if not config.webhook_function_name:
        raise WebhookNotConfiguredError("webhook delivery function is not configured")
    try:
        response = get_webhook_lambda_client().invoke(
            FunctionName=config.webhook_function_name,
            InvocationType="RequestResponse",
            Payload=json.dumps({"project_id": project_id, "event": EVENT_TEST}).encode("utf-8"),
        )
        raw = response["Payload"].read()
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code") or "ClientError"
        raise WebhookServiceError(f"invoke failed ({code})") from e
    except BotoCoreError as e:
        raise WebhookServiceError(f"invoke failed ({type(e).__name__})") from e
    if response.get("FunctionError"):
        raise WebhookServiceError(f"function error ({response['FunctionError']})")
    try:
        payload = json.loads(raw)
    except ValueError as e:
        raise WebhookServiceError("non-JSON response") from e
    if not isinstance(payload, dict):
        raise WebhookServiceError("non-object response")
    status = payload.get("status")
    if status == "skipped":
        raise WebhookSkippedError(str(payload.get("reason") or "not sent"))
    if status not in ("delivered", "failed") or not isinstance(payload.get("delivery_id"), str):
        raise WebhookServiceError(str(payload.get("error") or "unexpected response"))
    return payload
