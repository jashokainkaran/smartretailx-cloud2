import http from "k6/http";
import { check, sleep } from "k6";

// Cost-controlled load test against the DEPLOYED API Gateway/CloudFront
// stack — not DynamoDB Local like tests/k6/oversell_test.js. Read-only,
// public catalogue/inventory endpoints only.
//
// Checkout/order creation is deliberately excluded, on purpose, not an
// oversight: this project just cleared every test order out of the live
// orders table, and a repeatable load test that places real orders would
// just refill it — polluting the same admin dashboard stats that were the
// whole reason to delete them. A write-path load test is a genuinely
// different, riskier thing that would need its own explicit review of what
// it creates and how it gets cleaned up — not folded into this one.
//
// Three sequential, hard-capped stages — smoke, then two short concurrency
// steps — never an open-ended arrival-rate scenario. Run this only after
// the budget/billing alarms are confirmed (see cost_governance.tf), and
// don't repeat a run back-to-back until any failure is understood first.
const BASE = __ENV.SMARTRETAILX_API_BASE_URL || "https://d61p2h3x2e.execute-api.eu-west-1.amazonaws.com";

export const options = {
  scenarios: {
    smoke: {
      executor: "constant-vus",
      vus: 1,
      duration: "15s",
      exec: "browsePublicCatalogue",
      startTime: "0s",
    },
    concurrency_5: {
      executor: "constant-vus",
      vus: 5,
      duration: "20s",
      exec: "browsePublicCatalogue",
      startTime: "20s",
    },
    concurrency_10: {
      executor: "constant-vus",
      vus: 10,
      duration: "20s",
      exec: "browsePublicCatalogue",
      startTime: "45s",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<1500"],
    http_req_failed: ["rate<0.01"],
  },
};

export function browsePublicCatalogue() {
  const listResponse = http.get(`${BASE}/api/v1/products?limit=20`);
  check(listResponse, {
    "product list returns 200": (response) => response.status === 200,
  });

  const body = listResponse.json();
  const items = (body && body.items) || [];
  if (items.length > 0) {
    const product = items[Math.floor(Math.random() * items.length)];
    const stockResponse = http.get(`${BASE}/api/v1/inventory/${product.id}`);
    check(stockResponse, {
      "inventory read returns 200 or 404": (response) => response.status === 200 || response.status === 404,
    });
  }

  sleep(1);
}
