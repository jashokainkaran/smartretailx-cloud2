import { request } from "./http.js";

export function fetchPayment(paymentId, idToken) {
  return request(`/api/v1/payments/${encodeURIComponent(paymentId)}`, { idToken });
}

export function refundPayment(paymentId, idToken) {
  return request(`/api/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: "POST", idToken,
  });
}
