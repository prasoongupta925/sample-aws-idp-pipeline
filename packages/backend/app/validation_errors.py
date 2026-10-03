"""422 answers without the caller's input where it may be a secret.

FastAPI's default 422 body quotes each invalid value (``input``). For a PDF
password that is too long, or an upload token of the wrong shape, that would
put the secret in a response body (and in anything that records responses).
This handler keeps FastAPI's shape but drops ``input`` on the public upload
routes and on any field named ``password``.
"""

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.public_guard import PUBLIC_PATH_PREFIX

SECRET_FIELDS = frozenset({"password"})


def redact_errors(path: str, errors: list[dict]) -> list[dict]:
    public = path.startswith(PUBLIC_PATH_PREFIX)
    redacted = []
    for error in errors:
        loc = error.get("loc") or ()
        if public or any(part in SECRET_FIELDS for part in loc):
            error = {key: value for key, value in error.items() if key != "input"}
        redacted.append(error)
    return redacted


def install(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = redact_errors(request.url.path, list(exc.errors()))
        return JSONResponse(status_code=422, content={"detail": jsonable_encoder(errors)})
