# SmartRetailX — Cloud-Native Distributed Web Application

SmartRetailX is a cloud-native, event-driven retail platform built for a university cloud
architecture assignment (COMP60010 / ECDWA2). It replaces a hypothetical monolithic e-commerce
system with independently deployable microservices, an event backbone, managed identity, and
infrastructure defined entirely as code.

**Live deployment (`eu-west-1`, `dev` environment):**
- Storefront: https://d1vxg10hlsklfv.cloudfront.net
- API base URL: https://d61p2h3x2e.execute-api.eu-west-1.amazonaws.com
- WebSocket URL: wss://5qxdlljvh0.execute-api.eu-west-1.amazonaws.com/prod

## Architecture at a glance

- **Backend:** Python + FastAPI microservices, each wrapped with Mangum so the identical app
  runs locally under Uvicorn and in AWS Lambda without a code change. Six services exist:
  **Product Catalogue, Inventory, Payment, Order** (HTTP APIs behind API Gateway),
  **Notification** (SQS-triggered, sends order/delivery-status emails via SES), and
  **WebSocket** (three Lambda entrypoints — connect/disconnect/push-consumer — for live stock
  and admin order updates). A seventh, **User Profile**, is designed but not yet built.
- **Data:** DynamoDB, one table per service (database-per-service), plus two transactional
  outbox tables (product, order) that guarantee an event is never lost or double-published
  relative to its business write.
- **Event-driven:** an EventBridge bus fans events out to SQS queues (each with a dead-letter
  queue) rather than services calling each other directly for anything asynchronous. The order
  checkout Saga is the one place synchronous service-to-service HTTP calls are used, since a
  purchase needs a real-time answer.
- **Identity:** AWS Cognito — a user pool with `customers`/`admin` groups, Hosted UI (PKCE) for
  sign-in, and an API Gateway JWT authorizer validating every protected route. No hand-rolled
  auth anywhere in the system.
- **Deployment target:** API Gateway (HTTP API) + Lambda container images, with all
  infrastructure defined in Terraform (`terraform/`). ECS Fargate was evaluated as the
  brief-recommended container-orchestration target for longer-running workloads and is
  documented as a deliberate, cost-justified deferral rather than an implemented component.
- **Frontend:** React + Vite + Tailwind SPA — catalogue, basket, card/cash-on-delivery checkout,
  authenticated order history with live delivery-status tracking, and an admin panel (catalogue,
  stock, orders, delivery status, analytics dashboard) — served from a private S3 bucket via
  CloudFront with Origin Access Control, protected by AWS WAF.
- **Observability & cost governance:** a CloudWatch dashboard and 18 operational alarms — Lambda
  errors (one per function), DLQ depth, API Gateway 5xx, and two log-driven alarms on the order
  Saga specifically: `COMPENSATION_FAILED` (a terminal state needing manual reconciliation) and
  the circuit breaker tripping. DynamoDB throttling is visible on the dashboard but deliberately
  not alarmed on separately. Two AWS Budgets (actual + forecast, 50/80/100% thresholds) and a
  CloudWatch billing alarm round out cost governance — all Terraform-managed
  (`terraform/observability.tf`, `terraform/cost_governance.tf`).

## Repository structure

- `backend/services/` — the eight FastAPI/Lambda services (`product-service`,
  `inventory-service`, `payment-service`, `order-service`, `notification-service`,
  `websocket-service`, `outbox-relay`, `user-profile-service` [not yet built]), each with its
  own `app/`, `tests/`, `requirements.txt` and `Dockerfile`.
- `backend/functions/` — standalone Lambda functions not tied to a service, currently
  `cognito-post-confirmation` (auto-assigns new sign-ups to the `customers` group).
- `frontend/` — the React + Vite + Tailwind storefront and admin panel, with its own
  `tests/` (Vitest + React Testing Library).
- `terraform/` — all AWS infrastructure as code: networking, DynamoDB, EventBridge/SQS, ECR,
  Lambda, API Gateway (HTTP + WebSocket), Cognito, CloudFront/S3/WAF, observability, and cost
  governance.
- `scripts/` — local DynamoDB table-creation scripts (one per table), seed-data scripts, and
  `deploy-images.ps1`/`env-local.ps1`/`env-aws.ps1` helpers.
- `tests/` — cross-service integration tests and the k6 oversell-prevention load test.
- `docs/` — architecture decision records, the technical report draft, and exported OpenAPI
  definitions for all four HTTP services (`docs/api/`). Excluded from version control by choice
  (internal planning material) — present locally, not in the git history.
- `evidence/` — the screenshot capture guide, evidence log, and captured screenshots backing the
  report appendix. Also gitignored, for the same reason as `docs/`.

## Getting started (local)

**Prerequisites:** Docker, Python 3.11+ (each service has its own `venv`), Node.js.

1. Start DynamoDB Local from the repo root:
   ```powershell
   docker compose up -d
   ```
2. Point your shell at it (dot-source, so the variables persist in your current session):
   ```powershell
   . scripts\env-local.ps1
   ```
3. Create the tables you need, e.g.:
   ```powershell
   python scripts\create_product_table.py
   python scripts\create_inventory_table.py
   python scripts\create_orders_table.py
   python scripts\create_payments_table.py
   python scripts\create_outbox_table.py
   python scripts\create_order_outbox_table.py
   ```
4. Optionally seed sample data:
   ```powershell
   python scripts\seed_catalogue.py
   python scripts\seed_inventory.py
   ```
5. Run any of the four HTTP services (each from its own folder, its own venv activated):
   ```powershell
   cd backend\services\product-service
   .\venv\Scripts\Activate.ps1
   uvicorn app.main:app --reload --port 8080
   ```
   Ports: `product-service` 8080, `inventory-service` 8081, `payment-service` 8082,
   `order-service` 8083. Each exposes interactive API docs at `/docs`.
6. `notification-service`, `outbox-relay`, and `websocket-service` have no local HTTP server —
   they're pure Lambda handlers (SQS/DynamoDB-Stream/WebSocket-API triggered). Exercise them via
   their own `pytest` suites rather than running them directly.
7. Run the frontend:
   ```powershell
   cd frontend
   npm install
   npm run dev
   ```

## Running the tests

Each backend service has its own suite, run from its own folder with its own venv active:
```powershell
cd backend\services\<service-name>
.\venv\Scripts\python.exe -m pytest -v
```
Frontend: `cd frontend && npm test`. Load/concurrency test:
`k6 run tests\k6\oversell_test.js` (needs `inventory-service` running locally first — see the
test file for setup). CI (`.github/workflows/ci.yml`) runs every backend suite against a real
`amazon/dynamodb-local` service container, the frontend build/test, `terraform fmt`/`validate`,
a Docker build sanity check per service, and a dependency vulnerability scan — on every push,
without holding any AWS credentials.

## Deploying to AWS

1. `terraform/` — `terraform init`, then `terraform plan -var-file=dev.tfvars` /
   `terraform apply -var-file=dev.tfvars`. ECR repositories must exist with an image already
   pushed before the Lambda functions that reference them can apply (digest-pinned, not
   `:latest` — see `docs/architecture/ARCHITECTURE_DECISIONS.md` ADR-027).
2. Building and pushing a service's image (repeat per service, or use `scripts/deploy-images.ps1`):
   ```powershell
   docker build --provenance=false -t <name> .
   docker push <ecr-repository-url>:latest
   aws lambda update-function-code --function-name <fn> --image-uri <uri>
   ```
   The `--provenance=false` flag matters: BuildKit's default OCI manifest with attestation
   layers is rejected by Lambda, which needs a plain Docker v2 schema 2 manifest.
3. Frontend: `npm run build` in `frontend/`, then sync `dist/` to the S3 bucket and invalidate
   the CloudFront distribution (bucket name and distribution ID are Terraform outputs).

## API documentation

Every HTTP service exposes live interactive docs at `/docs` (Swagger UI) and `/openapi.json`.
Exported OpenAPI 3.1 definitions for all four HTTP services live in `docs/api/`.

## Security

Amazon Cognito issues JWTs on sign-in (Hosted UI, authorization-code flow with PKCE — no secret
ever reaches the browser). API Gateway's JWT authorizer validates every protected route before a
request reaches a service. Authorization is layered beyond that: service code reads
`customer_id`/roles from the token's own claims rather than trusting anything client-supplied,
so a customer can only ever see their own orders and an admin route is unreachable without the
`admin` group claim. IAM is least-privilege per Lambda — for example the inventory consumer can
only write new stock records, not read or modify existing ones.

## Observability & cost governance

A CloudWatch dashboard (`smartretailx-dev-operations`) and 18 alarms cover Lambda errors across
every function, dead-letter-queue depth, API Gateway 5xx responses, `COMPENSATION_FAILED`, and
circuit-breaker openings. DynamoDB throttling is visible on the dashboard but is not separately
alarmed. Two AWS Budgets (actual + forecast spend, alerting at 50/80/100%) and a CloudWatch billing
alarm in `us-east-1` (where the `AWS/Billing` metric lives) guard against unexpected spend —
deliberately alert-only, since AWS Budgets cannot stop resources that are already running.

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

## Known limitations

Honest, not exhaustive — full detail and the reasoning behind each in `docs/CHECKPOINT_STATUS.md`:

- **User Profile service** — designed, not built. Addresses, loyalty, and GDPR-consent data.
- **Container orchestration proof (ECS Fargate/EKS)** — deferred on cost grounds, documented as a
  justified architectural recommendation rather than an implemented component.
- **Multi-region disaster recovery** — no Route 53 failover or DynamoDB Global Tables yet; the
  current two-AZ deployment protects against an AZ failure, not a full regional outage.
- **KMS/Secrets Manager** — no customer-managed keys or SSM SecureString usage yet.
- **Performance testing against the deployed environment** — the k6 oversell test currently only
  runs against a local instance; a deployed run needs the cost-governance guardrails above in
  place first (now that they are, this is the next scheduled step).
- **Staging and production environments** — only the cost-controlled `dev` environment is
  deployed. The isolated dev → staging → production plan, including promotion safeguards, was
  deliberately designed and deferred; it is not represented as live infrastructure.
- **Account settings** — Cognito-backed self-service password management, optional TOTP MFA, and
  account deletion are approved next work; a full Profile service remains a later design. The
  price-change-at-checkout comparison is now built locally but awaits a clean integration run and
  deployment; see `docs/CHECKPOINT_STATUS.md` CP-049.

## Architectural decisions

All key architectural decisions and their rationale are recorded as ADRs in
[docs/architecture/ARCHITECTURE_DECISIONS.md](docs/architecture/ARCHITECTURE_DECISIONS.md).
