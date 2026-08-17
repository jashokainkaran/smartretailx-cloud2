import { request } from "./http.js";

export function createOrder({
  items, shippingAddress, contactEmail, contactPhone, paymentMethod, paymentToken, idToken,
}) {
  const body = {
    items,
    shipping_address: shippingAddress,
    contact_email: contactEmail,
    contact_phone: contactPhone,
    payment_method: paymentMethod,
  };
  // Omitted entirely for cash on delivery, not sent as null — matches the
  // backend model, where payment_token is optional and only required when
  // payment_method is "card" (order-service/app/models.py).
  if (paymentMethod === "card") body.payment_token = paymentToken;
  return request("/api/v1/orders", { method: "POST", idToken, body });
}

export function fetchMyOrders({ limit = 20, cursor, idToken } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return request(`/api/v1/orders?${params.toString()}`, { idToken });
}

export function fetchAttentionOrders(idToken) {
  return request("/api/v1/orders/stuck", { idToken });
}
