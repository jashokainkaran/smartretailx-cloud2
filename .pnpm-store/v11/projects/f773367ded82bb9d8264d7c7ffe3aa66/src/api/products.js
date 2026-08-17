import { request } from "./http.js";

// Fetch a page of products. Pass the previous page's `next_cursor` to get the next one.
export function fetchProducts({ limit = 12, cursor, includeInactive = false, idToken } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  if (includeInactive) params.set("include_inactive", "true");
  return request(`/api/v1/products?${params.toString()}`, { idToken });
}

export function fetchProductById(id, idToken) {
  return request(`/api/v1/products/${encodeURIComponent(id)}`, { idToken });
}

export function fetchAdminProducts({ limit = 100, cursor, idToken } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return request(`/api/v1/products/admin?${params.toString()}`, { idToken });
}

export function createProduct(product, idToken) {
  return request("/api/v1/products", { method: "POST", body: product, idToken });
}

export function updateProduct(id, product, idToken) {
  return request(`/api/v1/products/${encodeURIComponent(id)}`, {
    method: "PUT", body: product, idToken,
  });
}

export function setProductActive(id, active, idToken) {
  return request(`/api/v1/products/${encodeURIComponent(id)}/${active ? "activate" : "deactivate"}`, {
    method: "PATCH", idToken,
  });
}
