# Browser E2E tests

Real Playwright tests against the deployed CloudFront site and API Gateway —
not a local dev server, not mocked data. Covers the customer journey, the
admin journey, and the two/three-tab WebSocket live-update proof.

## Prerequisites

- The demo catalogue must already be seeded (`scripts/seed_catalogue.py`) —
  these tests look for specific real product names ("Highland Roast Coffee
  Beans", "Ceylon Breakfast Tea").
- The dedicated Cognito test customer/admin accounts must already exist
  (same two accounts the CD pipeline already uses).

## Setup

```
cd tests/e2e
npm install
npx playwright install chromium
```

Set four environment variables before running — the suite authenticates
itself via `aws cognito-idp initiate-auth` (same flow the CD pipeline uses),
so no browser sign-in or manually-copied token is ever needed:

```
SMARTRETAILX_TEST_CUSTOMER_EMAIL=...
SMARTRETAILX_TEST_CUSTOMER_PASSWORD=...
SMARTRETAILX_TEST_ADMIN_EMAIL=...
SMARTRETAILX_TEST_ADMIN_PASSWORD=...
```

## Running

```
npm test              # headless, runs all three journeys in order
npm run test:headed   # same, with visible browser windows
npm run report        # opens the HTML report from the last run
```

Screenshots land in `evidence/screenshots/e2e/`, named in the order they're
taken across the three journeys (`01-...` through `15-...`). The full
Playwright HTML report (with traces on any failure) lives in
`tests/e2e/playwright-report/` after a run.

## Why three numbered files, not one

`01-customer-journey.spec.js` places a real order that
`02-admin-journey.spec.js` then updates the delivery status of, and
`03-websocket-live-update.spec.js` places a second, different order to keep
its own evidence unambiguous from the first. The numbered filenames plus
`fullyParallel: false` / `workers: 1` in `playwright.config.js` are what
guarantee that order — nothing here explicitly waits for another file.

## Why sign-in is token injection, not the real Hosted UI

Cognito's Hosted UI is a redirect to an AWS-hosted login page — not this
app's own code, so automating that form doesn't test anything this project
built. `fixtures.js` instead writes a real, freshly-obtained session straight
into `sessionStorage` the way `frontend/src/auth/cognito.js` already expects
one to be stored, so every test starts already signed in as the real
account, through the real JWT authorizer, for whatever it does next.
