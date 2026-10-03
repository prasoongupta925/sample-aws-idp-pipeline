"""Customer upload links: token rules, staff endpoints, public endpoints, guard.

The router tests replace the storage functions with an in-memory store that
keeps the same rules as the DynamoDB conditions (app/ddb/upload_links.py); the
conditions themselves are checked against a mocked table at the end.
"""

import json
import time
from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

import app.ddb.upload_links as ddb_links
import app.pdf_unlock as pdf_unlock
import app.routers.public_upload as public_router
import app.routers.upload_links as staff_router
from app import public_guard
from app.ddb.models import Document, DocumentData
from app.main import app
from app.upload_links import (
    CONSENT_VERSION,
    MAX_FILE_BYTES,
    MAX_FILES,
    MAX_UNLOCK_ATTEMPTS,
    clean_text,
    customer_extension,
    document_keys,
    new_token,
    token_hash,
    valid_token,
)

client = TestClient(app)
PROJECT = "proj-1"
UA = "Mozilla/5.0 (Linux; Android 14) Mobile"


# --- helpers -----------------------------------------------------------------


class FakeStore:
    """In-memory stand-in for app.ddb.upload_links and the document table."""

    def __init__(self):
        self.links: dict[str, dict] = {}
        self.pointers: dict[tuple[str, str], dict] = {}
        self.consents: list[dict] = []
        self.docs: dict[tuple[str, str], DocumentData] = {}

    # app.ddb.upload_links
    def put_link(self, hashed, link):
        assert hashed not in self.links
        self.links[hashed] = dict(link)
        self.pointers[(link["project_id"], link["link_id"])] = {
            "link_id": link["link_id"],
            "token_hash": hashed,
            "created_at": link["created_at"],
            "expires_at": link["expires_at"],
        }

    def get_link(self, hashed):
        link = self.links.get(hashed)
        return dict(link) if link else None

    def get_pointer(self, project_id, link_id):
        return self.pointers.get((project_id, link_id))

    def query_pointers(self, project_id):
        return [p for (proj, _), p in self.pointers.items() if proj == project_id]

    def reserve_file_slot(self, hashed, *, now_epoch):
        link = self.links.get(hashed)
        if (
            not link
            or link["status"] != "active"
            or link["expires_at"] <= now_epoch
            or link["file_count"] >= link["max_files"]
            or not link.get("consented_at")
        ):
            return None
        link["file_count"] += 1
        return link["file_count"]

    def record_consent(self, hashed, **record):
        self.consents.append({"token_hash": hashed, **record})
        self.links[hashed].setdefault("consented_at", record["consented_at"])

    def close_link(self, hashed, status, *, at):
        link = self.links.get(hashed)
        if not link or link["status"] != "active":
            return False
        link.update(status=status, closed_at=at)
        return True

    def count_unlock_attempt(self, project_id, document_id, *, max_attempts):
        data = self.docs[(project_id, document_id)]
        if data.unlock_attempts >= max_attempts:
            return False
        data.unlock_attempts += 1
        return True

    def set_document_fields(self, project_id, document_id, fields):
        data = self.docs[(project_id, document_id)]
        for name, value in fields.items():
            setattr(data, name, value)

    def set_document_status_if(self, project_id, document_id, *, status, expected):
        data = self.docs[(project_id, document_id)]
        if data.status != expected:
            return False
        data.status = status
        return True

    # app.ddb documents
    def put_document_item(self, project_id, document_id, data):
        self.docs[(project_id, document_id)] = data.model_copy()

    def _doc(self, data):
        return Document(
            PK=f"PROJ#{data.project_id}",
            SK=f"DOC#{data.document_id}",
            data=data.model_copy(),
            created_at="2026-10-01T00:00:00+00:00",
            updated_at="2026-10-01T00:00:00+00:00",
        )

    def get_document_item(self, project_id, document_id):
        data = self.docs.get((project_id, document_id))
        return self._doc(data) if data else None

    def query_documents(self, project_id):
        return [self._doc(d) for (proj, _), d in self.docs.items() if proj == project_id]


@pytest.fixture
def store(monkeypatch):
    s = FakeStore()
    for name in ("put_link", "get_link", "get_pointer", "query_pointers", "close_link"):
        monkeypatch.setattr(staff_router, name, getattr(s, name))
    for name in ("set_document_fields", "set_document_status_if"):
        monkeypatch.setattr(staff_router, name, getattr(s, name))
    monkeypatch.setattr(staff_router, "get_project_item", lambda pid: {"project_id": pid} if pid == PROJECT else None)
    monkeypatch.setattr(staff_router, "get_document_item", s.get_document_item)
    monkeypatch.setattr(staff_router, "mark_project_updated", lambda pid: None)
    for name in ("get_link", "close_link", "reserve_file_slot", "record_consent", "count_unlock_attempt"):
        monkeypatch.setattr(public_router, name, getattr(s, name))
    for name in ("put_document_item", "get_document_item", "query_documents"):
        monkeypatch.setattr(public_router, name, getattr(s, name))
    config = MagicMock(document_storage_bucket_name="doc-bucket", dsa_name="your loan advisor")
    monkeypatch.setattr(staff_router, "get_config", lambda: config)
    monkeypatch.setattr(public_router, "get_config", lambda: config)
    presign = MagicMock(side_effect=lambda bucket, key, **kw: f"https://s3.example/{key}")
    monkeypatch.setattr(public_router, "presign_put", presign)
    s.presign = presign
    return s


def create_link(**body):
    payload = {"items": [{"code": "BANK_STATEMENT"}, {"code": "OTHER", "note": "Rent\nagreement"}], **body}
    response = client.post(f"/projects/{PROJECT}/upload-links", json=payload, headers={"x-user-id": "staff-1"})
    assert response.status_code == 201, response.text
    return response.json()


def hdr(token):
    return {"x-upload-token": token, "user-agent": UA}


def consent(token):
    response = client.post(
        "/public/upload-link/consent",
        json={"accepted": True, "language": "hi", "consent_version": CONSENT_VERSION},
        headers=hdr(token),
    )
    assert response.status_code == 200, response.text


def add_file(token, name="statement.pdf", ctype="application/pdf", size=2048, encrypted=False):
    return client.post(
        "/public/upload-link/files",
        json={"file_name": name, "content_type": ctype, "file_size": size, "encrypted": encrypted},
        headers=hdr(token),
    )


# --- token and key rules -----------------------------------------------------


class TestRules:
    def test_token_is_256_bits_and_stored_hashed(self):
        token = new_token()
        assert valid_token(token)
        assert len(token) == 43
        assert token_hash(token) != token
        assert len(token_hash(token)) == 64
        assert new_token() != token

    @pytest.mark.parametrize("token", [None, "", "short", "a" * 44, "a" * 42 + "!", "../" + "a" * 40])
    def test_invalid_tokens(self, token):
        assert not valid_token(token)

    def test_customer_extensions(self):
        assert customer_extension("PAN.JPG") == "jpg"
        assert customer_extension("statement.pdf") == "pdf"
        assert customer_extension("call.mp3") is None
        assert customer_extension("noext") is None

    def test_clean_text(self):
        assert clean_text("  Rent\nagreement\x00 ", 120) == "Rentagreement"
        assert clean_text(None, 5) == ""
        assert clean_text("x" * 10, 5) == "xxxxx"

    def test_locked_key_is_one_level_deeper(self):
        final, locked = document_keys("p", "d", "pdf")
        assert final == "projects/p/documents/d/d.pdf"
        assert locked == "projects/p/documents/d/locked/d.pdf"


# --- staff endpoints ---------------------------------------------------------


class TestStaffLinks:
    def test_create_returns_token_once_and_stores_hash(self, store):
        body = create_link(language="mr", expires_in_hours=24)
        token = body["token"]
        assert valid_token(token)
        assert body["link_id"].startswith("ul_")
        assert body["status"] == "active"
        assert body["language"] == "mr"
        assert body["dsa_name"] == "your loan advisor"
        assert body["max_files"] == MAX_FILES
        assert body["items"][1] == {"code": "OTHER", "note": "Rentagreement"}
        # only the hash is a key; the token is stored nowhere
        assert list(store.links) == [token_hash(token)]
        assert token not in json.dumps(store.links) + json.dumps(list(store.pointers.values()))
        link = store.links[token_hash(token)]
        assert 23 * 3600 < link["expires_at"] - time.time() <= 24 * 3600
        assert link["created_by"] == "staff-1"

    def test_default_expiry_is_72_hours(self, store):
        body = create_link()
        link = store.links[token_hash(body["token"])]
        assert 71 * 3600 < link["expires_at"] - time.time() <= 72 * 3600

    @pytest.mark.parametrize(
        "body",
        [
            {"items": []},
            {"items": [{"code": "bank statement"}]},
            {"items": [{"code": "PAN"}], "expires_in_hours": 7 * 24 + 1},
            {"items": [{"code": "PAN"}], "expires_in_hours": 0},
            {"items": [{"code": "PAN"}], "language": "ta"},
            {"items": [{"code": "PAN"}] * 21},
        ],
    )
    def test_create_validation(self, store, body):
        response = client.post(f"/projects/{PROJECT}/upload-links", json=body)
        assert response.status_code == 422

    def test_create_unknown_project(self, store):
        response = client.post("/projects/nope/upload-links", json={"items": [{"code": "PAN"}]})
        assert response.status_code == 404

    def test_list_never_returns_tokens(self, store):
        first = create_link()
        create_link()
        response = client.get(f"/projects/{PROJECT}/upload-links")
        assert response.status_code == 200
        links = response.json()
        assert len(links) == 2
        assert all("token" not in link for link in links)
        assert first["token"] not in response.text

    def test_revoke_stops_the_public_page(self, store):
        body = create_link()
        assert client.get("/public/upload-link", headers=hdr(body["token"])).status_code == 200
        response = client.delete(f"/projects/{PROJECT}/upload-links/{body['link_id']}")
        assert response.status_code == 200
        assert response.json()["status"] == "revoked"
        assert client.get("/public/upload-link", headers=hdr(body["token"])).status_code == 404

    def test_revoke_other_project_is_404(self, store):
        body = create_link()
        response = client.delete(f"/projects/other/upload-links/{body['link_id']}")
        assert response.status_code == 404

    def test_expired_link_is_listed_as_expired(self, store):
        body = create_link()
        store.links[token_hash(body["token"])]["expires_at"] = int(time.time()) - 1
        links = client.get(f"/projects/{PROJECT}/upload-links").json()
        assert links[0]["status"] == "expired"


# --- public endpoints --------------------------------------------------------


class TestPublicLink:
    def test_get_shows_dsa_items_and_no_internal_ids(self, store):
        body = create_link(dsa_name="Verma Loan Services")
        response = client.get("/public/upload-link", headers=hdr(body["token"]))
        assert response.status_code == 200
        data = response.json()
        assert data["dsa_name"] == "Verma Loan Services"
        assert [i["code"] for i in data["items"]] == ["BANK_STATEMENT", "OTHER"]
        assert data["consented"] is False
        assert data["max_file_bytes"] == MAX_FILE_BYTES
        assert PROJECT not in response.text
        assert body["link_id"] not in response.text

    @pytest.mark.parametrize("token", [None, "x", "a" * 43])
    def test_bad_tokens_get_the_same_404(self, store, token):
        create_link()
        headers = {"x-upload-token": token} if token else {}
        for method, path in (
            ("get", "/public/upload-link"),
            ("post", "/public/upload-link/submit"),
            ("post", "/public/upload-link/files"),
        ):
            kwargs = {"json": {"file_name": "a.pdf", "content_type": "application/pdf", "file_size": 1}}
            response = getattr(client, method)(path, headers=headers, **(kwargs if method == "post" else {}))
            assert response.status_code == 404, (path, response.text)
            assert response.json()["detail"] == public_router.LINK_NOT_FOUND

    def test_token_in_query_string_is_ignored(self, store):
        body = create_link()
        response = client.get(f"/public/upload-link?token={body['token']}")
        assert response.status_code == 404

    def test_expired_link_is_404(self, store):
        body = create_link()
        store.links[token_hash(body["token"])]["expires_at"] = int(time.time()) - 1
        assert client.get("/public/upload-link", headers=hdr(body["token"])).status_code == 404

    def test_consent_is_logged_with_time_link_and_user_agent(self, store):
        body = create_link()
        consent(body["token"])
        assert len(store.consents) == 1
        record = store.consents[0]
        assert record["link_id"] == body["link_id"]
        assert record["user_agent"] == UA
        assert record["language"] == "hi"
        assert record["consent_version"] == CONSENT_VERSION
        datetime.fromisoformat(record["consented_at"])
        assert 6 * 86400 < record["expires_at"] - time.time() <= 7 * 86400
        assert client.get("/public/upload-link", headers=hdr(body["token"])).json()["consented"] is True

    def test_consent_must_be_accepted_and_current(self, store):
        token = create_link()["token"]
        r = client.post(
            "/public/upload-link/consent",
            json={"accepted": False, "consent_version": CONSENT_VERSION},
            headers=hdr(token),
        )
        assert r.status_code == 400
        r = client.post(
            "/public/upload-link/consent", json={"accepted": True, "consent_version": "old"}, headers=hdr(token)
        )
        assert r.status_code == 409
        assert store.consents == []

    def test_no_upload_before_consent(self, store):
        token = create_link()["token"]
        assert add_file(token).status_code == 403
        store.presign.assert_not_called()

    def test_upload_goes_to_the_project_upload_path(self, store):
        body = create_link(language="mr")
        consent(body["token"])
        response = add_file(body["token"], name="PAN.jpg", ctype="image/jpeg")
        assert response.status_code == 200, response.text
        doc_id = response.json()["document_id"]
        key = f"projects/{PROJECT}/documents/{doc_id}/{doc_id}.jpg"
        store.presign.assert_called_once_with("doc-bucket", key, content_type="image/jpeg", content_length=2048)
        data = store.docs[(PROJECT, doc_id)]
        assert data.source == "customer_link"
        assert data.upload_link_id == body["link_id"]
        assert data.status == "uploading"
        assert data.language == "mr"
        assert data.s3_key == key
        files = client.get("/public/upload-link", headers=hdr(body["token"])).json()["files"]
        assert files == [{"document_id": doc_id, "file_name": "PAN.jpg", "status": "uploading", "locked": False}]

    @pytest.mark.parametrize(
        "name,ctype,size,status",
        [
            ("call.mp3", "audio/mpeg", 100, 400),
            ("report.docx", "application/octet-stream", 100, 400),
            ("pan.jpg", "application/pdf", 100, 400),
            ("big.pdf", "application/pdf", MAX_FILE_BYTES + 1, 422),
            ("empty.pdf", "application/pdf", 0, 422),
        ],
    )
    def test_upload_type_and_size_limits(self, store, name, ctype, size, status):
        token = create_link()["token"]
        consent(token)
        assert add_file(token, name=name, ctype=ctype, size=size).status_code == status
        store.presign.assert_not_called()

    def test_at_most_max_files(self, store):
        token = create_link()["token"]
        consent(token)
        for _ in range(MAX_FILES):
            assert add_file(token).status_code == 200
        response = add_file(token)
        assert response.status_code == 409
        assert len(store.docs) == MAX_FILES

    def test_submit_closes_the_link(self, store):
        token = create_link()["token"]
        consent(token)
        add_file(token)
        response = client.post("/public/upload-link/submit", headers=hdr(token))
        assert response.status_code == 200
        assert response.json() == {"status": "submitted", "file_count": 1}
        assert client.get("/public/upload-link", headers=hdr(token)).status_code == 404
        assert add_file(token).status_code == 404
        assert client.post("/public/upload-link/submit", headers=hdr(token)).status_code == 404


class TestPasswordProtectedPdf:
    @pytest.fixture
    def locked(self, store):
        body = create_link()
        consent(body["token"])
        response = add_file(body["token"], encrypted=True)
        assert response.status_code == 200
        assert response.json()["status"] == "password_required"
        return body["token"], response.json()["document_id"]

    def unlock(self, token, doc_id, password="Asha1990"):
        return client.post(
            f"/public/upload-link/files/{doc_id}/unlock", json={"password": password}, headers=hdr(token)
        )

    def test_locked_pdf_is_uploaded_to_the_locked_key(self, store, locked):
        _, doc_id = locked
        key = store.presign.call_args.args[1]
        assert key == f"projects/{PROJECT}/documents/{doc_id}/locked/{doc_id}.pdf"
        data = store.docs[(PROJECT, doc_id)]
        assert data.locked is True
        assert data.s3_key == f"projects/{PROJECT}/documents/{doc_id}/{doc_id}.pdf"

    def test_only_pdfs_can_be_encrypted(self, store):
        token = create_link()["token"]
        consent(token)
        assert add_file(token, name="pan.jpg", ctype="image/jpeg", encrypted=True).status_code == 400

    def test_unlock_moves_it_into_the_pipeline_and_logs_no_password(self, store, locked, capsys):
        token, doc_id = locked
        with patch.object(staff_router, "unlock_pdf", return_value={"status": "unlocked", "size": 1500}) as unlock:
            response = self.unlock(token, doc_id, password="S3cretPwd!")
        assert response.status_code == 200
        assert response.json()["status"] == "unlocked"
        final, locked_key = document_keys(PROJECT, doc_id, "pdf")
        unlock.assert_called_once_with(locked_key, final, "S3cretPwd!")
        data = store.docs[(PROJECT, doc_id)]
        assert (data.locked, data.status, data.file_size) == (False, "uploaded", 1500)
        assert "S3cretPwd!" not in capsys.readouterr().out
        assert "S3cretPwd!" not in json.dumps({k[1]: v.model_dump() for k, v in store.docs.items()})

    def test_wrong_password_counts_attempts(self, store, locked):
        token, doc_id = locked
        with patch.object(staff_router, "unlock_pdf", return_value={"status": "wrong_password"}):
            for left in range(MAX_UNLOCK_ATTEMPTS - 1, -1, -1):
                response = self.unlock(token, doc_id)
                assert response.status_code == 200
                assert response.json() == {"status": "wrong_password", "attempts_left": left}
            assert self.unlock(token, doc_id).status_code == 429
        assert store.docs[(PROJECT, doc_id)].status == "password_required"

    def test_unlock_of_another_links_document_is_404(self, store, locked):
        _, doc_id = locked
        other = create_link()["token"]
        with patch.object(staff_router, "unlock_pdf") as unlock:
            assert self.unlock(other, doc_id).status_code == 404
        unlock.assert_not_called()

    def test_unlock_of_an_unlocked_document_is_409(self, store):
        token = create_link()["token"]
        consent(token)
        doc_id = add_file(token).json()["document_id"]
        assert self.unlock(token, doc_id).status_code == 409

    def test_staff_unlock(self, store, locked):
        _, doc_id = locked
        url = f"/projects/{PROJECT}/documents/{doc_id}/unlock"
        with patch.object(staff_router, "unlock_pdf", return_value={"status": "wrong_password"}):
            assert client.post(url, json={"password": "x"}).status_code == 400
        with patch.object(staff_router, "unlock_pdf", return_value={"status": "unlocked", "size": 10}):
            assert client.post(url, json={"password": "y"}).json() == {"status": "unlocked"}
        assert store.docs[(PROJECT, doc_id)].status == "uploaded"

    def test_unlock_not_configured(self, store, locked):
        token, doc_id = locked
        with patch.object(staff_router, "unlock_pdf", side_effect=pdf_unlock.PdfUnlockNotConfiguredError()):
            assert self.unlock(token, doc_id).status_code == 503


# --- pdf unlock client -------------------------------------------------------


class TestPdfUnlockClient:
    def _invoke(self, monkeypatch, payload=None, function_error=None, error=None):
        monkeypatch.setattr(pdf_unlock, "get_config", lambda: MagicMock(pdf_unlock_function_name="idp-v2-pdf-unlock"))
        lam = MagicMock()
        if error:
            lam.invoke.side_effect = error
        else:
            resp = {"Payload": MagicMock(read=lambda: json.dumps(payload).encode())}
            if function_error:
                resp["FunctionError"] = function_error
            lam.invoke.return_value = resp
        monkeypatch.setattr(pdf_unlock, "_lambda_client", lam)
        return lam

    def test_unlocked(self, monkeypatch):
        lam = self._invoke(monkeypatch, {"status": "unlocked", "size": 42})
        assert pdf_unlock.unlock_pdf("a", "b", "pw") == {"status": "unlocked", "size": 42}
        sent = json.loads(lam.invoke.call_args.kwargs["Payload"])
        assert sent == {"source_key": "a", "target_key": "b", "password": "pw"}

    def test_wrong_password(self, monkeypatch):
        self._invoke(monkeypatch, {"status": "wrong_password"})
        assert pdf_unlock.unlock_pdf("a", "b", "pw") == {"status": "wrong_password"}

    def test_errors_never_carry_the_password(self, monkeypatch):
        self._invoke(monkeypatch, {"errorMessage": "boom"}, function_error="Unhandled")
        with pytest.raises(pdf_unlock.PdfUnlockServiceError) as e:
            pdf_unlock.unlock_pdf("a", "b", "pw-secret")
        assert "pw-secret" not in str(e.value)
        err = ClientError({"Error": {"Code": "AccessDenied", "Message": "pw-secret"}}, "Invoke")
        self._invoke(monkeypatch, error=err)
        with pytest.raises(pdf_unlock.PdfUnlockServiceError) as e:
            pdf_unlock.unlock_pdf("a", "b", "pw-secret")
        assert "pw-secret" not in str(e.value)
        assert e.value.__cause__ is None

    def test_not_configured(self, monkeypatch):
        monkeypatch.setattr(pdf_unlock, "get_config", lambda: MagicMock(pdf_unlock_function_name=""))
        with pytest.raises(pdf_unlock.PdfUnlockNotConfiguredError):
            pdf_unlock.unlock_pdf("a", "b", "pw")


# --- public guard ------------------------------------------------------------


IAM_CONTEXT = json.dumps({"authorizer": {"iam": {"userArn": "arn:aws:sts::000000000000:assumed-role/x/y"}}})
OPEN_CONTEXT = json.dumps({"requestId": "r1"})


class TestPublicGuard:
    @pytest.mark.parametrize(
        "path,context,ok",
        [
            ("/projects", None, True),
            ("/projects", IAM_CONTEXT, True),
            ("/projects", OPEN_CONTEXT, False),
            ("/projects", "not json", False),
            ("/projects", json.dumps({"authorizer": {"iam": {}}}), False),
            ("/public/upload-link", OPEN_CONTEXT, True),
            ("/publicx", OPEN_CONTEXT, False),
        ],
    )
    def test_allowed(self, path, context, ok):
        assert public_guard.allowed(path, context) is ok

    def test_unauthenticated_call_to_a_staff_route_is_refused(self, store):
        response = client.get(f"/projects/{PROJECT}/upload-links", headers={"x-amzn-request-context": OPEN_CONTEXT})
        assert response.status_code == 403

    def test_unauthenticated_call_to_the_public_route_passes(self, store):
        token = create_link()["token"]
        headers = {**hdr(token), "x-amzn-request-context": OPEN_CONTEXT}
        assert client.get("/public/upload-link", headers=headers).status_code == 200


# --- DynamoDB conditions -----------------------------------------------------


def _conditional_failed():
    return ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")


class TestDdbConditions:
    @pytest.fixture
    def table(self, monkeypatch):
        table = MagicMock()
        monkeypatch.setattr(ddb_links, "get_table", lambda: table)
        return table

    def test_put_link_never_overwrites(self, table):
        ddb_links.put_link("h", {"link_id": "ul_1", "project_id": "p", "created_at": "t", "expires_at": 1})
        first = table.put_item.call_args_list[0].kwargs
        assert first["Item"]["PK"] == "ULINK#h"
        assert first["ConditionExpression"] == "attribute_not_exists(PK)"
        pointer = table.put_item.call_args_list[1].kwargs["Item"]
        assert (pointer["PK"], pointer["SK"], pointer["token_hash"]) == ("PROJ#p", "ULINK#ul_1", "h")

    def test_reserve_slot_condition(self, table):
        table.update_item.return_value = {"Attributes": {"file_count": 3}}
        assert ddb_links.reserve_file_slot("h", now_epoch=100) == 3
        condition = table.update_item.call_args.kwargs["ConditionExpression"]
        for part in ("#status = :active", "expires_at > :now", "file_count < max_files", "consented_at"):
            assert part in condition
        table.update_item.side_effect = _conditional_failed()
        assert ddb_links.reserve_file_slot("h", now_epoch=100) is None

    def test_close_link_only_when_active(self, table):
        assert ddb_links.close_link("h", "submitted", at="t") is True
        assert "#status = :active" in table.update_item.call_args.kwargs["ConditionExpression"]
        table.update_item.side_effect = _conditional_failed()
        assert ddb_links.close_link("h", "submitted", at="t") is False

    def test_unlock_attempt_limit(self, table):
        assert ddb_links.count_unlock_attempt("p", "d", max_attempts=5) is True
        assert table.update_item.call_args.kwargs["ExpressionAttributeValues"][":max"] == 5
        table.update_item.side_effect = _conditional_failed()
        assert ddb_links.count_unlock_attempt("p", "d", max_attempts=5) is False

    def test_other_errors_are_raised(self, table):
        table.update_item.side_effect = ClientError({"Error": {"Code": "Throttling"}}, "UpdateItem")
        with pytest.raises(ClientError):
            ddb_links.close_link("h", "revoked", at="t")

    def test_consent_record(self, table):
        ddb_links.record_consent(
            "h",
            link_id="ul_1",
            project_id="p",
            consented_at="2026-10-03T00:00:00+00:00",
            user_agent=UA,
            language="en",
            consent_version=CONSENT_VERSION,
            expires_at=5,
        )
        item = table.put_item.call_args.kwargs["Item"]
        assert item["SK"] == "CONSENT#2026-10-03T00:00:00+00:00"
        assert item["user_agent"] == UA
        assert "if_not_exists(consented_at" in table.update_item.call_args.kwargs["UpdateExpression"]
