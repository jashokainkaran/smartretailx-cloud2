// Shared browser-to-API transport. Keeping token handling here ensures every
// customer and administrator call uses the same authenticated request shape.
import { clearStoredSession, isTokenExpired } from "../auth/cognito.js";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || window.location.origin;
const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please sign in again.";

export class ApiError extends Error {
  constructor(message, status, details = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

// A 401 here always means "no usable claims" (app/auth.py), which in
// practice means the ID token expired — Cognito ID tokens are only valid an
// hour and this app has no refresh-token renewal yet. Clearing the stale
// session and telling AuthProvider turns a confusing bare 401 into the UI
// flipping back to "Sign in", instead of the header still claiming you're
// signed in while every request quietly keeps failing.
function signalSessionExpired() {
  clearStoredSession();
  window.dispatchEvent(new Event("smartretailx:session-expired"));
}

export async function request(path, { method = "GET", body, idToken } = {}) {
  if (idToken && isTokenExpired(idToken)) {
    signalSessionExpired();
    throw new ApiError(SESSION_EXPIRED_MESSAGE, 401);
  }

  const headers = {};
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Could not reach SmartRetailX. Please try again.", 0);
  }

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    if (response.status === 401) {
      signalSessionExpired();
      throw new ApiError(SESSION_EXPIRED_MESSAGE, 401);
    }
    const detail = typeof payload === "object" && payload?.detail;
    const message = typeof detail === "string"
      ? detail
      : detail?.message || `Request failed (${response.status}).`;
    throw new ApiError(message, response.status, typeof detail === "object" ? detail : null);
  }

  return payload;
}
