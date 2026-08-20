"""Small standard-library helpers for scripts that exercise the deployed API.

No passwords, AWS keys, or tokens are stored in this repository. Each script
prompts for a short-lived Cognito ID token when it needs one.
"""

from __future__ import annotations

import base64
import getpass
import json
import os
import time
from typing import Any
from urllib import error, request


DEFAULT_API_BASE_URL = "https://d61p2h3x2e.execute-api.eu-west-1.amazonaws.com"


class ApiError(RuntimeError):
    """An HTTP response from the deployed application that was not successful."""


def normalise_api_base_url(value: str) -> str:
    return value.rstrip("/")


def _decode_jwt_payload(token: str) -> dict[str, Any]:
    """Read token expiry/email locally; API Gateway validates it on the request."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
    except (IndexError, UnicodeDecodeError, ValueError):
        raise ValueError("That does not look like a Cognito ID token.") from None


def prompt_for_id_token() -> tuple[str, dict[str, Any]]:
    """Get a token without printing it or putting it in shell history."""
    token = os.getenv("SMARTRETAILX_ID_TOKEN")
    if not token:
        print("Paste a fresh Cognito ID token from the signed-in web app. It will stay hidden.")
        token = getpass.getpass("Cognito ID token: ").strip()
    if not token:
        raise ValueError("A Cognito ID token is required.")

    claims = _decode_jwt_payload(token)
    expiry = claims.get("exp")
    if not isinstance(expiry, (int, float)) or expiry <= time.time():
        raise ValueError("The Cognito ID token has expired. Sign in again and copy a fresh token.")
    return token, claims


def request_json(api_base_url: str, path: str, *, method: str = "GET", token: str | None = None, body: dict[str, Any] | None = None) -> tuple[int, Any]:
    """Call a JSON API endpoint and return its HTTP status and JSON body."""
    headers = {"Accept": "application/json"}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")

    outgoing = request.Request(f"{normalise_api_base_url(api_base_url)}{path}", data=data, headers=headers, method=method)
    try:
        with request.urlopen(outgoing, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else None
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            details: Any = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            details = raw
        raise ApiError(f"{method} {path} returned HTTP {exc.code}: {details}") from None
    except error.URLError as exc:
        raise ApiError(f"Could not reach {api_base_url}: {exc.reason}") from None
