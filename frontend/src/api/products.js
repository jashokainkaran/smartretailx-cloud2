// Single source of truth for talking to the Product Catalogue API.
// Components never call fetch() directly — they go through here.

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`);
  } catch {
    // Network failure, CORS block, API unreachable, etc.
    throw new ApiError("Could not reach the Product Catalogue API.", 0);
  }

  if (!response.ok) {
    throw new ApiError(
      `Product Catalogue API returned ${response.status}.`,
      response.status
    );
  }

  return response.json();
}

// Fetch a page of products. Pass the previous page's `next_cursor` to get the next one.
export function fetchProducts({ limit = 12, cursor } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return request(`/api/v1/products?${params.toString()}`);
}

export function fetchProductById(id) {
  return request(`/api/v1/products/${encodeURIComponent(id)}`);
}
