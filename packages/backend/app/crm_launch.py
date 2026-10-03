"""Signed launch link from the Smart Dial CRM (docs/crm-launch-link.md).

The CRM opens the app on a lead with

    https://<app>/launch?lead=<id>&name=<name>&phone=<phone>&exp=<unix>&sig=<hex>

sig = lowercase hex HMAC-SHA256(key = the CRM's launch secret as UTF-8,
message = the canonical query). The canonical query is every parameter except
sig, sorted by name, each name and value percent-encoded as RFC 3986
(unreserved A-Z a-z 0-9 - . _ ~ kept, UTF-8, spaces as %20) and joined as
name=value with "&". lead and exp are required, name and phone optional, any
other parameter is refused (so nothing unsigned can ride along).

Checks, in order: the shape of every value, the signature (constant time), the
expiry (exp must be in the future and at most MAX_LIFETIME_S ahead, plus
CLOCK_SKEW_S), and replay: the first use stores LAUNCH#<sig> with a conditional
put, a second use of the same link is refused. Those items expire with
DynamoDB TTL an hour after the link does.

The secret is per CRM (one CRM, "smartdial", today) and stored on the item
PK = CRM#<crm>, SK = LAUNCH as KMS ciphertext (the webhook key of WebhookStack,
encryption context {crm, purpose: crm-launch-secret}). Unlike the webhook
secrets the backend must read it back to verify links, so its role may Encrypt
and Decrypt with that purpose only. Admins rotate it (POST
/integrations/crm-launch/secret), which returns the new secret once.

The link never signs anybody in: the user still signs in with Cognito first.
"""

import base64
import hashlib
import hmac
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, quote

from botocore.exceptions import BotoCoreError, ClientError

from app.config import get_config
from app.ddb.client import get_table, now_iso
from app.webhook_secret import SecretEncryptionError, SecretKeyNotConfiguredError, get_kms_client

CRM_ID = "smartdial"
SECRET_PURPOSE = "crm-launch-secret"
SECRET_BYTES = 32
MAX_LIFETIME_S = 300
CLOCK_SKEW_S = 30
REPLAY_KEEP_S = 3600
MAX_QUERY_LENGTH = 2048

ALLOWED_PARAMS = frozenset({"lead", "name", "phone", "exp", "sig"})
_LEAD_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
_PHONE_RE = re.compile(r"^\+?[0-9][0-9 ()-]{5,19}$")
_EXP_RE = re.compile(r"^[0-9]{1,12}$")
_SIG_RE = re.compile(r"^[0-9a-f]{64}$")
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
MAX_NAME_LENGTH = 120


class LaunchLinkError(Exception):
    """The link is not valid; the message says why (never the secret)."""


class LaunchSecretMissingError(Exception):
    """No launch secret was generated yet for the CRM."""


@dataclass(frozen=True)
class LaunchRequest:
    lead: str
    name: str | None
    phone: str | None
    exp: int
    sig: str


# ------------------------------------------------------------------ signing
def canonical_query(params: dict[str, str]) -> str:
    """name=value pairs except sig, sorted by name, RFC 3986 percent-encoded, joined with "&"."""
    return "&".join(f"{quote(k, safe='-._~')}={quote(v, safe='-._~')}" for k, v in sorted(params.items()) if k != "sig")


def sign(secret: str, params: dict[str, str]) -> str:
    """Lowercase hex HMAC-SHA256 of the canonical query (what the CRM puts in sig)."""
    return hmac.new(secret.encode("utf-8"), canonical_query(params).encode("utf-8"), hashlib.sha256).hexdigest()


def parse_query(query: str) -> dict[str, str]:
    """The parameters of a raw query string (with or without "?"); refuses repeats and unknown names."""
    query = query[1:] if query.startswith("?") else query
    if len(query) > MAX_QUERY_LENGTH:
        raise LaunchLinkError("The launch link is too long")
    try:
        pairs = parse_qsl(query, keep_blank_values=True, strict_parsing=True, errors="strict")
    except (ValueError, UnicodeDecodeError) as e:
        raise LaunchLinkError("The launch link is malformed") from e
    params: dict[str, str] = {}
    for key, value in pairs:
        if key not in ALLOWED_PARAMS:
            raise LaunchLinkError(f"Unknown launch link parameter: {key[:32]!r}")
        if key in params:
            raise LaunchLinkError(f"The launch link repeats the parameter {key}")
        params[key] = value
    return params


def check_shape(params: dict[str, str]) -> LaunchRequest:
    lead, exp, sig = params.get("lead", ""), params.get("exp", ""), params.get("sig", "")
    if not _LEAD_RE.match(lead):
        raise LaunchLinkError("lead must be 1-64 of A-Z a-z 0-9 . _ : -")
    if not _EXP_RE.match(exp):
        raise LaunchLinkError("exp must be a unix time in seconds")
    if not _SIG_RE.match(sig):
        raise LaunchLinkError("sig must be 64 lowercase hex characters")
    name = params.get("name")
    if name is not None:
        name = name.strip()
        if len(name) > MAX_NAME_LENGTH or _CONTROL_RE.search(name):
            raise LaunchLinkError(f"name must be at most {MAX_NAME_LENGTH} characters, without control characters")
    phone = params.get("phone")
    if phone is not None and phone != "" and not _PHONE_RE.match(phone):
        raise LaunchLinkError("phone must be digits, with an optional leading + and spaces ( ) -")
    return LaunchRequest(lead=lead, name=name or None, phone=phone or None, exp=int(exp), sig=sig)


def verify(params: dict[str, str], secret: str, *, now: float | None = None) -> LaunchRequest:
    """The checked launch request; LaunchLinkError when the shape, signature or expiry is wrong.

    Replay is checked separately (mark_used), after this succeeds.
    """
    request = check_shape(params)
    if not hmac.compare_digest(sign(secret, params), request.sig):
        raise LaunchLinkError("The launch link signature is not valid")
    t = time.time() if now is None else now
    if request.exp <= t:
        raise LaunchLinkError("The launch link has expired; open it again from the CRM")
    if request.exp > t + MAX_LIFETIME_S + CLOCK_SKEW_S:
        raise LaunchLinkError(f"The launch link expiry is more than {MAX_LIFETIME_S // 60} minutes ahead")
    return request


# ------------------------------------------------------------------ storage
def _settings_key() -> dict[str, str]:
    return {"PK": f"CRM#{CRM_ID}", "SK": "LAUNCH"}


def encryption_context() -> dict[str, str]:
    return {"crm": CRM_ID, "purpose": SECRET_PURPOSE}


def _key_arn() -> str:
    key_arn = get_config().webhook_secret_key_arn
    if not key_arn:
        raise SecretKeyNotConfiguredError("launch secret key is not configured")
    return key_arn


def _kms_error(action: str, e: Exception) -> SecretEncryptionError:
    code = (
        (e.response.get("Error", {}).get("Code") or "ClientError") if isinstance(e, ClientError) else type(e).__name__
    )
    return SecretEncryptionError(f"{action} failed ({code})")


def get_settings() -> dict[str, Any]:
    """{secret_set, rotated_at, rotated_by} of the CRM launch secret (never the secret)."""
    item = get_table().get_item(Key=_settings_key(), ConsistentRead=True).get("Item") or {}
    return {
        "secret_set": bool(item.get("secret_enc")),
        "rotated_at": item.get("rotated_at"),
        "rotated_by": item.get("rotated_by"),
    }


def rotate_secret(rotated_by: str) -> str:
    """A new launch secret: stored encrypted (replacing the old one at once) and returned once."""
    secret = secrets.token_urlsafe(SECRET_BYTES)
    try:
        response = get_kms_client().encrypt(
            KeyId=_key_arn(), Plaintext=secret.encode("utf-8"), EncryptionContext=encryption_context()
        )
    except (ClientError, BotoCoreError) as e:
        raise _kms_error("encrypt", e) from e
    get_table().put_item(
        Item={
            **_settings_key(),
            "secret_enc": base64.b64encode(response["CiphertextBlob"]).decode("ascii"),
            "rotated_at": now_iso(),
            "rotated_by": rotated_by,
        }
    )
    return secret


def load_secret() -> str:
    item = get_table().get_item(Key=_settings_key(), ConsistentRead=True).get("Item") or {}
    secret_enc = item.get("secret_enc")
    if not secret_enc:
        raise LaunchSecretMissingError("no launch secret yet")
    _key_arn()
    try:
        response = get_kms_client().decrypt(
            CiphertextBlob=base64.b64decode(secret_enc), EncryptionContext=encryption_context()
        )
    except (ClientError, BotoCoreError) as e:
        raise _kms_error("decrypt", e) from e
    return response["Plaintext"].decode("utf-8")


def mark_used(request: LaunchRequest) -> None:
    """Record the link as used; LaunchLinkError when it was used before (replay)."""
    try:
        get_table().put_item(
            Item={
                "PK": f"LAUNCH#{request.sig}",
                "SK": "USED",
                "lead": request.lead,
                "used_at": now_iso(),
                "expires_at": request.exp + REPLAY_KEEP_S,
            },
            ConditionExpression="attribute_not_exists(PK)",
        )
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            raise LaunchLinkError("This launch link was already used; open it again from the CRM") from e
        raise
