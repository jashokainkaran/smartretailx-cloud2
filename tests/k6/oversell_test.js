import http from 'k6/http';
import { check } from 'k6';

// 200 virtual users, each firing ONE reserve request, all at once.
export const options = {
  scenarios: {
    flash_sale: {
      executor: 'per-vu-iterations',
      vus: 200,          // 200 concurrent virtual users
      iterations: 1,     // each does exactly 1 reservation
      maxDuration: '30s',
    },
  },
};

const BASE = 'http://127.0.0.1:8081';
const PRODUCT = 'test-product-1';

export default function () {
  const res = http.post(
    `${BASE}/api/v1/inventory/${PRODUCT}/reserve?quantity=1`
  );

  // We EXPECT some to succeed (200) and some to be rejected (409).
  // Both are "correct" outcomes — what matters is the totals.
  check(res, {
    'status is 200 or 409': (r) => r.status === 200 || r.status === 409,
  });
}