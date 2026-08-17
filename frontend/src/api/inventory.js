import { request } from "./http.js";

export function fetchStock(productId, idToken) {
  return request(`/api/v1/inventory/${encodeURIComponent(productId)}`, { idToken });
}

export function addStock(productId, quantity, idToken) {
  return request(`/api/v1/inventory/${encodeURIComponent(productId)}/add?quantity=${encodeURIComponent(quantity)}`, {
    method: "POST", idToken,
  });
}
