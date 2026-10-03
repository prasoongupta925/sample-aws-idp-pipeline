"""Customer upload links: the rules shared by the staff and the public endpoints.

Staff create a link for a project (POST /projects/{id}/upload-links). The
customer opens ``https://<app>/u#<token>``: the token sits in the URL
fragment, which the browser never sends to a server (no CloudFront log, no
Referer), and the page sends it in the ``X-Upload-Token`` header of every
public call (/public/upload-link/...; never in a path or query string, so the
access log cannot hold it).

- The token is 32 random bytes (256 bits, ``secrets.token_urlsafe``). Only its
  SHA-256 is stored: a plain hash is enough for a random value of that size
  (nothing to brute-force), and a leaked table does not give working links.
- A link lives 1 hour to 7 days (default 72 hours; DynamoDB TTL deletes it at
  its expiry, and every call checks the expiry itself because TTL deletion is
  late). It ends when the customer presses Submit or staff revoke it.
- At most MAX_FILES files of at most MAX_FILE_BYTES each, PDFs and photos
  only. Every file reserves a slot first (an atomic counter), so the limit
  holds even for parallel calls.
- No file can be uploaded before the DPDP consent is logged.
"""

import hashlib
import re
import secrets

TOKEN_BYTES = 32
# token_urlsafe(32): 43 characters of [A-Za-z0-9_-].
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")
TOKEN_HEADER = "x-upload-token"

DEFAULT_EXPIRY_HOURS = 72
MIN_EXPIRY_HOURS = 1
MAX_EXPIRY_HOURS = 7 * 24

MAX_FILES = 20
MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_ITEMS = 20
MAX_NOTE_LENGTH = 120
MAX_DSA_NAME_LENGTH = 80
# Wrong passwords the customer may try per locked PDF; then staff unlock it.
MAX_UNLOCK_ATTEMPTS = 5
MAX_PASSWORD_LENGTH = 128
MAX_USER_AGENT_LENGTH = 256

LANGUAGES = ("en", "hi", "mr")

# What a customer may upload: PDFs and photos (camera capture gives JPEG; PNG
# and WebP for screenshots). The extensions must be in presigned.UPLOAD_CONTENT_TYPES.
CUSTOMER_EXTENSIONS = frozenset({"pdf", "jpg", "jpeg", "png", "webp"})

# Version of the consent text shown on the page (frontend data/customerUpload.ts).
CONSENT_VERSION = "2026-10-v1"

# Document codes the web app has names for (en/hi/mr); OTHER takes a note.
ITEM_CODE_PATTERN = re.compile(r"^[A-Z0-9_]{1,40}$")
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")

SOURCE_CUSTOMER_LINK = "customer_link"

STATUS_ACTIVE = "active"
STATUS_SUBMITTED = "submitted"
STATUS_REVOKED = "revoked"
STATUS_EXPIRED = "expired"

# Document statuses of a password-protected PDF waiting for its password.
DOC_PASSWORD_REQUIRED = "password_required"


def new_token() -> str:
    """A fresh link token (256 bits)."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def token_hash(token: str) -> str:
    """The stored form of a token."""
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def valid_token(token: str | None) -> bool:
    return bool(token) and TOKEN_PATTERN.fullmatch(token) is not None


def clean_text(value: str | None, max_length: int) -> str:
    """Trim, drop control characters, cap the length."""
    return _CONTROL_CHARS.sub("", value or "").strip()[:max_length]


def customer_extension(file_name: str) -> str | None:
    """The lower-case extension when a customer may upload this file, else None."""
    if "." not in file_name:
        return None
    ext = file_name.rsplit(".", 1)[-1].lower()
    return ext if ext in CUSTOMER_EXTENSIONS else None


def document_keys(project_id: str, document_id: str, ext: str) -> tuple[str, str]:
    """(final key, locked key) of a customer upload.

    The final key is the project's normal upload path: its ObjectCreated event
    starts the pipeline. A password-protected PDF goes to ``locked/`` inside the
    document's folder first: that key is one level deeper, which the S3 upload
    rule (EventStack, anything-but projects/*/documents/*/*/*) ignores, so the
    pipeline starts only when the unlocked copy is written to the final key.
    Deleting the document (or the retention sweep) deletes the whole folder.
    """
    folder = f"projects/{project_id}/documents/{document_id}"
    return f"{folder}/{document_id}.{ext}", f"{folder}/locked/{document_id}.{ext}"
