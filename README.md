# SmartRetailX — Cloud-Native Distributed Web Application

SmartRetailX is a cloud-native, distributed retail platform built as university coursework.
It's a microservices-based e-commerce backend built on AWS-native services, paired with a
React storefront, and is designed to be promoted through local, staging, and production
environments using the same infrastructure-as-code.

## Architecture at a glance

- **Backend:** Python + FastAPI microservices, one per domain (users, products, inventory,
  orders, payments, notifications), each with its own DynamoDB table.
- **Event-driven:** services communicate asynchronously via EventBridge and SQS rather than
  direct calls, where appropriate.
- **Identity:** authentication and authorization via AWS Cognito.
- **Deployment target:** API Gateway + Lambda, with infrastructure defined in Terraform.
- **Frontend:** React + Vite + Tailwind single-page storefront, served as static assets
  (S3 + CloudFront in the cloud).

## Repository structure

- `backend/` — the FastAPI microservices (`services/`) and the API gateway (`gateway/`).
- `frontend/` — the React + Tailwind storefront.
- `infrastructure/` — Terraform (`aws/`), Kubernetes manifests (`k8s/`), Docker assets
  (`docker/`), and architecture diagrams (`diagrams/`).
- `scripts/` — table creation, seed data, and other helper scripts.
- `tests/` — Postman collections, k6 load tests, and integration tests.
- `docs/` — architecture, API, and security documentation.
- `evidence/` — screenshots, logs, and test outputs for the report appendix.
- `report/` — the written coursework report.

## Getting started (local)

**Prerequisites:** Docker, Python 3.11+, Node.js.

1. Start DynamoDB Local (via Docker):
   ```bash
   docker run -p 8000:8000 amazon/dynamodb-local
   ```
2. Create the products table:
   ```bash
   python scripts/create_table.py
   ```
3. Seed sample data:
   ```bash
   python scripts/seed_products.py
   ```
4. Run the product-service:
   ```bash
   cd backend/services/product-service
   uvicorn app.main:app --reload --port 8080
   ```
5. Run the frontend:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

## Correctness and reliability — what's tested and working

Beyond the feature list above, a number of specific failure modes have actually occurred during
development against real AWS infrastructure — not just been anticipated — and are now closed with
a regression test proving each one stays fixed. Full reasoning for every item, plus the exact test
name for each, is in `docs/IMPLEMENTATION_RECORD.md`'s consolidated testing index (search for
"consolidated testing index"); this is the short version:

- **No overselling under concurrent load.** Atomic conditional writes on stock reservation, proven
  by a 200-virtual-user k6 scenario against 100 units of real stock (100 successes, 100 rejections,
  zero oversold) and by unit tests for both single-item and whole-basket reservations.
- **Saga compensation never guesses.** A downstream 4xx (a definite refusal) and a downstream
  timeout/5xx (a genuine unknown) are handled by opposite logic on purpose — a refusal gets
  compensated, an unknown outcome never does, since compensating something that may never have
  happened causes the exact damage compensation exists to prevent.
- **Money is never a float.** Every monetary value is `Decimal` end-to-end, transmitted as a JSON
  string and re-quantized to two decimal places on the way out of DynamoDB — closing two separate,
  real trailing-zero bugs found by failing tests, not by inspection.
- **A payment attempt is never silently lost.** The payment record is written before the provider
  is ever called, so a provider exception still leaves a record (`UNKNOWN`, not nothing) that a
  human can reconcile.
- **Cognito role checks work against the real claim shape API Gateway sends**, not just the
  hardcoded shape the test-mode bypass used — a real, previously-shipped bug where a single-group
  claim silently rejected every genuine sign-in.
- **A rejected EventBridge publish is treated as a failure, not a silent success.** `put_events()`
  can return a 200-level response while rejecting the one entry inside it; every publish path now
  checks for that explicitly instead of trusting the HTTP status alone.
- **One bad message in a queue batch can't duplicate another message's side effects.** Both the
  Notification and WebSocket SQS consumers isolate each record's failure and report it individually,
  instead of letting one exception fail — and retry — an entire batch of already-handled messages.
- **A broken product image degrades to a placeholder**, including the specific case of an image
  that starts loading and then fails, not just a URL that was never set.

## Architectural decisions

All key architectural decisions and their rationale are recorded as ADRs in
[docs/architecture/ARCHITECTURE_DECISIONS.md](docs/architecture/ARCHITECTURE_DECISIONS.md).
