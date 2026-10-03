"""Keeps unauthenticated API calls on the public routes.

The HTTP API (common-constructs app/apis/backend.ts) has two kinds of routes to
this function:
- ``/{proxy+}`` with the IAM authorizer (every staff call, SigV4-signed);
- ``/public/{proxy+}`` without an authorizer (the customer upload page; the
  link token in X-Upload-Token is checked on every call there).

API Gateway already sends only /public/... paths through the open route, and
FastAPI does not normalize ``..`` in a path, so /public/../projects matches no
route. This guard is the second line: on Lambda the Lambda Web Adapter puts
the API Gateway request context in the ``x-amzn-request-context`` header
(replacing any header of that name the caller sent). A request whose context
has no IAM identity may reach /public/ paths only; anything else gets 403.

Outside Lambda (tests, a local uvicorn, the adapter's readiness check) the
header is absent and the guard lets the request through.
"""

import json

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

REQUEST_CONTEXT_HEADER = "x-amzn-request-context"
PUBLIC_PATH_PREFIX = "/public/"


def has_iam_identity(context_header: str) -> bool:
    """True when the API Gateway request context carries an IAM caller."""
    try:
        context = json.loads(context_header)
    except ValueError:
        return False
    if not isinstance(context, dict):
        return False
    authorizer = context.get("authorizer")
    iam = authorizer.get("iam") if isinstance(authorizer, dict) else None
    return isinstance(iam, dict) and bool(iam)


def allowed(path: str, context_header: str | None) -> bool:
    if context_header is None:
        return True
    return path.startswith(PUBLIC_PATH_PREFIX) or has_iam_identity(context_header)


def install(app: FastAPI) -> None:
    @app.middleware("http")
    async def public_guard(request: Request, call_next):
        if not allowed(request.url.path, request.headers.get(REQUEST_CONTEXT_HEADER)):
            return JSONResponse(status_code=403, content={"detail": "Forbidden"})
        return await call_next(request)
