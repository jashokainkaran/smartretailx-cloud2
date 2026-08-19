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

// Admin-only — every order across every customer, not just the signed-in
// user's own (see order-service/app/main.py's list_all_orders_admin for why
// this is a separate, gated endpoint rather than an option on the customer
// listing above).
export function fetchAllOrdersAdmin({ limit = 20, cursor, idToken } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return request(`/api/v1/orders/admin?${params.toString()}`, { idToken });
}

export function updateDeliveryStatus(orderId, deliveryStatus, idToken) {
  return request(`/api/v1/orders/${encodeURIComponent(orderId)}/delivery-status`, {
    method: "PATCH",
    idToken,
    body: { delivery_status: deliveryStatus },
  });
}

// Today's orders, aggregated server-side — the admin dashboard's analytics
// panel. Not paginated, since it returns one summary object, not a list.
export function fetchOrderSummary(idToken) {
  return request("/api/v1/orders/admin/summary", { idToken });
}

// Admin-only. These are confirmed orders with no fulfilment status yet;
// setting PROCESSING (or a later delivery state) removes one from this list.
export function fetchReadyToShip({ limit = 5, idToken } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  return request(`/api/v1/orders/admin/ready-to-ship?${params.toString()}`, { idToken });
}
