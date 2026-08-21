import http from "k6/http";
import { check } from "k6";

// Deliberately induces the same Lambda/API Gateway throttling that turned up
// by accident during a browser-driven catalogue load on 2026-08-21 (a burst
// of ~12 concurrent GET /api/v1/inventory/{id} calls produced two real 503s
// and briefly tripped smartretailx-dev-api-gateway-5xx). This script
// reproduces it on purpose, with a clean, designed burst instead of an
// accidental one, so it can be written up as an actual test rather than an
// incidental observation.
//
// Read-only (GET /api/v1/inventory/{id} only) — no orders created, nothing
// to clean up. A single short constant-VUs burst, not a ramp: the point is
// concurrency pressure in a narrow window, not sustained load.
const BASE = __ENV.SMARTRETAILX_API_BASE_URL || "https://d61p2h3x2e.execute-api.eu-west-1.amazonaws.com";

export const options = {
  scenarios: {
    inventory_burst: {
      executor: "constant-vus",
      vus: 60,
      duration: "10s",
      exec: "hitInventory",
    },
  },
};

export function setup() {
  const res = http.get(`${BASE}/api/v1/products?limit=20`);
  const body = res.json();
  const ids = (body.items || []).map((p) => p.id);
  return { ids };
}

export function hitInventory(data) {
  const id = data.ids[Math.floor(Math.random() * data.ids.length)];
  const res = http.get(`${BASE}/api/v1/inventory/${id}`);
  check(res, {
    "not throttled (503)": (r) => r.status !== 503,
    "status is 200 or 404": (r) => r.status === 200 || r.status === 404,
  });
}
