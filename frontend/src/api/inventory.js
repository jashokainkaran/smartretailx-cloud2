import { request } from "./http.js";

export function fetchStock(productId, idToken) {
  return request(`/api/v1/inventory/${encodeURIComponent(productId)}`, { idToken });
}

export function addStock(productId, quantity, idToken) {
  return request(`/api/v1/inventory/${encodeURIComponent(productId)}/add?quantity=${encodeURIComponent(quantity)}`, {
    method: "POST", idToken,
  });
}

// Admin-only — every product at or below `threshold` available units.
export function fetchLowStock(idToken, threshold = 10) {
  return request(`/api/v1/inventory/admin/low-stock?threshold=${encodeURIComponent(threshold)}`, { idToken });
}
