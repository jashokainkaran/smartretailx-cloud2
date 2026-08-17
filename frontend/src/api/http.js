// Shared browser-to-API transport. Keeping token handling here ensures every
// customer and administrator call uses the same authenticated request shape.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || window.location.origin;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function request(path, { method = "GET", body, idToken } = {}) {
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
    const detail = typeof payload === "object" && payload?.detail
      ? payload.detail
      : `Request failed (${response.status}).`;
    throw new ApiError(detail, response.status);
  }

  return payload;
}

