"""The OCR endpoint availability check the Settings page uses."""

import boto3
import pytest
from botocore.stub import Stubber
from fastapi.testclient import TestClient

import app.routers.sagemaker as sagemaker_router
from app.main import app

client = TestClient(app)


@pytest.fixture
def stubbed_sagemaker(monkeypatch):
    sm = boto3.client("sagemaker", region_name="ap-south-1")
    stubber = Stubber(sm)
    monkeypatch.setattr(sagemaker_router, "get_sagemaker_client", lambda: sm)
    with stubber:
        yield stubber
    stubber.assert_no_pending_responses()


def _params():
    return {"EndpointName": sagemaker_router.config.paddleocr_endpoint_name}


def test_available_when_endpoint_exists(stubbed_sagemaker):
    stubbed_sagemaker.add_response(
        "describe_endpoint",
        {
            "EndpointName": "paddleocr-endpoint",
            "EndpointArn": "arn:aws:sagemaker:ap-south-1:000000000000:endpoint/paddleocr-endpoint",
            "EndpointConfigName": "cfg",
            "EndpointStatus": "InService",
            "CreationTime": "2026-01-01T00:00:00Z",
            "LastModifiedTime": "2026-01-01T00:00:00Z",
        },
        _params(),
    )
    response = client.get("/sagemaker/availability")
    assert response.status_code == 200
    assert response.json() == {"available": True}


def test_not_available_when_endpoint_missing(stubbed_sagemaker):
    stubbed_sagemaker.add_client_error(
        "describe_endpoint",
        service_error_code="ValidationException",
        service_message='Could not find endpoint "paddleocr-endpoint".',
        http_status_code=400,
        expected_params=_params(),
    )
    response = client.get("/sagemaker/availability")
    assert response.status_code == 200
    assert response.json() == {"available": False}


def test_other_errors_are_500_without_aws_detail(stubbed_sagemaker):
    stubbed_sagemaker.add_client_error(
        "describe_endpoint",
        service_error_code="AccessDeniedException",
        service_message="User arn:aws:sts::000000000000:assumed-role/x is not authorized",
        http_status_code=403,
        expected_params=_params(),
    )
    response = client.get("/sagemaker/availability")
    assert response.status_code == 500
    assert "arn:" not in response.text


def test_status_still_404_when_endpoint_missing(stubbed_sagemaker):
    stubbed_sagemaker.add_client_error(
        "describe_endpoint",
        service_error_code="ValidationException",
        service_message='Could not find endpoint "paddleocr-endpoint".',
        http_status_code=400,
        expected_params=_params(),
    )
    response = client.get("/sagemaker/status")
    assert response.status_code == 404
