# Evidence Log

Every screenshot captured for the report appendix, what it shows, and which
assignment task it supports. Filled in as evidence is captured, not
retrospectively — a deployment that has been torn down cannot be
screenshotted afterwards.

**Convention:** `evidence/screenshots/<area>/<NN>-<slug>.png`
**Region:** every AWS console screenshot must show **eu-west-1 (Ireland)** in
the top right. A screenshot of the wrong region proves nothing.

---

## Capture list

### Local — tests and tooling

| # | Filename | What it must show | Task | Done |
|---|---|---|---|---|
| 1 | `tests/01-pytest-product-service.png` | `python -m pytest -v` in product-service — 16 passed, test names legible | 8 | ☐ |
| 2 | `tests/02-pytest-inventory-service.png` | 20 passed, including `test_batch_reserve_is_all_or_nothing` | 8 | ☐ |
| 3 | `tests/03-pytest-payment-service.png` | 14 passed | 8 | ☐ |
| 4 | `tests/04-pytest-order-service.png` | 26 passed, saga branch names legible | 8 | ☐ |
| 5 | `tests/05-k6-oversell-local.png` | k6 summary — zero oversell under 200-way concurrency | 6 | ☐ |
| 6 | `api-docs/01-swagger-order-service.png` | Swagger UI at `localhost:8083/docs`, order endpoints expanded | 2, 8 | ☐ |
| 7 | `api-docs/02-swagger-saga-confirmed.png` | Swagger "Execute" response: 201, `status: CONFIRMED` | 8 | ☐ |
| 8 | `api-docs/03-swagger-saga-declined.png` | Swagger response with `tok_test_decline`: `status: FAILED` | 8 | ☐ |

### Infrastructure as code

| # | Filename | What it must show | Task | Done |
|---|---|---|---|---|
| 9 | `terraform/01-terraform-validate.png` | `Success! The configuration is valid.` | 1 | ☐ |
| 10 | `terraform/02-terraform-plan-summary.png` | The plan summary line — additions, changes, **0 to destroy** | 1 | ☐ |
| 11 | `terraform/03-terraform-apply-complete.png` | `Apply complete!` with the resource count and outputs | 1 | ☐ |
| 12 | `terraform/04-deploy-images-script.png` | `deploy-images.ps1` output — build, push, update-function-code | 1 | ☐ |

### Deployed architecture

| # | Filename | What it must show | Task | Done |
|---|---|---|---|---|
| 13 | `api-gateway/01-routes.png` | API Gateway → Routes: 8 routes, 2 per service | 2 | ☐ |
| 14 | `api-gateway/02-stage-and-throttling.png` | `$default` stage, access logging, throttle limits | 2, 5 | ☐ |
| 15 | `lambda/01-function-list.png` | Lambda → Functions filtered on `smartretailx` — 7 functions | 2 | ☐ |
| 16 | `lambda/02-order-api-config.png` | order-api → Environment variables — table names, service URLs, timeout, **no credentials** | 3 | ☐ |
| 17 | `iam/01-order-api-policy-json.png` | The order-api role policy JSON — orders table + `/index/*` only, **nothing** on products/inventory/payments | 3 | ☐ |
| 18 | `iam/02-inventory-two-roles.png` | The consumer role (PutItem only) beside the API role (Get/Put/Update) — one image, two Lambdas, two privilege levels | 3 | ☐ |
| 19 | `dynamodb/01-tables-list.png` | Six tables, all with point-in-time recovery | 1, 5 | ☐ |
| 20 | `dynamodb/02-orders-three-statuses.png` | Orders table items — CONFIRMED, FAILED, REJECTED together | 4 | ☐ |
| 21 | `dynamodb/03-order-confirmed-item.png` | The CONFIRMED order expanded — snapshotted `unit_price`, `payment_id`, **no `saga_status`** | 4 | ☐ |
| 22 | `dynamodb/04-order-failed-item.png` | The FAILED order — `failure_reason` naming the decline | 4 | ☐ |
| 23 | `dynamodb/05-order-outbox-published.png` | Outbox records with `published_at` and `ttl`, **no `status`** — the relay published and cleared them | 4 | ☐ |
| 24 | `events/01-event-bus-rules.png` | EventBridge bus and its rules | 4 | ☐ |
| 25 | `events/02-sqs-queue-and-dlq.png` | The queue with its DLQ redrive at maxReceiveCount 3 | 5 | ☐ |

### Network and edge (applied this session, 2026-08-15)

| # | Filename | What it must show | Task | Done |
|---|---|---|---|---|
| 37 | `network/01-vpc-and-subnets.png` | VPC console → Your VPCs (`smartretailx-dev-vpc`, `10.0.0.0/16`) and Subnets — 4 subnets, `Tier`/`Role`/`Services` tags visible | 1, 3 | ☐ |
| 38 | `network/02-route-tables.png` | Private route table — **no `0.0.0.0/0` route**, only local + the DynamoDB endpoint; public route table **with** the IGW route, side by side | 3 | ☐ |
| 39 | `network/03-security-groups.png` | `smartretailx-dev-lambda-sg` — Inbound rules tab **empty**, Outbound showing only the two 443 rules | 3 | ☐ |
| 40 | `network/04-vpc-endpoints.png` | Both endpoints — Gateway (DynamoDB) and Interface (events) — both `Available` | 3 | ☐ |
| 41 | `network/05-flow-logs.png` | VPC → Flow logs tab, `Active`, destination the CloudWatch log group | 3 | ☐ |
| 42 | `waf/01-web-acl-rules.png` | WAF web ACL rules — common rule set, known-bad-inputs, per-IP rate limit 2000, attached to the CloudFront distribution | 3 | ☐ |
| 43 | `hosting/01-cloudfront-distribution.png` | CloudFront distribution — both origins (S3 via OAC, API Gateway on `/api/*`) | 1, 3 | ☐ |
| 44 | `hosting/02-s3-bucket-private.png` | S3 bucket → Permissions — all four public-access-block toggles **On**; Properties — versioning **Enabled** | 3 | ☐ |

### The saga, proven

| # | Filename | What it must show | Task | Done |
|---|---|---|---|---|
| 26 | `saga/01-three-orders-terminal-states.png` | PowerShell table: CONFIRMED / FAILED / REJECTED with reasons, from the deployed API | 4 | ☐ |
| 27 | `saga/02-inventory-after-compensation.png` | Stock at 8 available / **0 reserved** — the decline released its hold | 4, 5 | ☐ |
| 28 | `saga/03-stuck-orders-empty.png` | `/orders/stuck` returning empty — every order reached a healthy terminal state | 4 | ☐ |
| 29 | `saga/04-order-api-state-transitions.png` | CloudWatch log lines: `order state change … PENDING -> RESERVING_STOCK`, `order failed … (stock released)` | 7 | ☐ |

### Observability

| # | Filename | What it must show | Task | Done |
|---|---|---|---|---|
| 30 | `observability/01-xray-service-map.png` | X-Ray service map — gateway, order-api, inventory-api, payment-api, DynamoDB, connected | 7 | ☐ |
| 31 | `observability/02-xray-trace-waterfall.png` | A single trace timeline showing each downstream call's duration | 7 | ☐ |
| 32 | `observability/03-log-group-retention.png` | Log groups with 14-day retention set | 7 | ☐ |
| 33 | `observability/04-cloudwatch-dashboard.png` | The dashboard — *pending, item 9* | 7 | ☐ |
| 34 | `observability/05-alarms.png` | Three alarms including COMPENSATION_FAILED — *pending, item 9* | 7 | ☐ |

### Cost governance

| # | Filename | What it must show | Task | Done |
|---|---|---|---|---|
| 35 | `cost/01-budget-alert.png` | AWS Budgets showing the configured alert | 1 | ☐ |
| 36 | `cost/02-cost-explorer.png` | Actual spend to date — supports the cost-effectiveness stance, not a £0 claim | 1 | ☐ |

### Notification service and today's fixes (2026-08-18)

| # | Filename | What it must show | Task | Done |
|---|---|---|---|---|
| 45 | `tests/06-pytest-order-service-with-correlation-id.png` | `pytest -v` in order-service — 59 passed, the two `correlation_id` regression tests visible | 8 | ☐ |
| 46 | `tests/07-pytest-notification-service.png` | `pytest -v` in notification-service — 14 passed | 8 | ☐ |
| 47 | `terraform/05-plan-six-fixes.png` | `terraform plan -var-file=dev.tfvars` — 6 in-place updates (IAM, DLQ reporting, 3x digest pin, VPC removal), **0 to destroy** | 1 | ☐ |
| 48 | `lambda/03-notification-service-no-vpc.png` | notification-service → Configuration → VPC tab, **no VPC configured** | 3, 5 | ☐ |
| 49 | `iam/03-notification-service-policy-json.png` | The notification-service-policy JSON — `GetItem`+`PutItem` on one table, `SendEmail` scoped to one identity ARN | 3 | ☐ |
| 50 | `sqs/01-notifications-trigger-partial-batch.png` | notification-service → Triggers → SQS trigger config, **"Report batch item failures" enabled** | 5 | ☐ |
| 51 | `ses/01-identity-verified.png` | SES → Identities → the sender address, status **Verified** | 3 | ☐ |
| 52 | `dynamodb/06-notifications-table-item.png` | Notifications table — a real sent `event_id` from a live checkout | 4 | ☐ |
| 53 | `observability/06-notification-log-correlation-id.png` | CloudWatch Logs, notification-service — a `Sent OrderConfirmed receipt ... correlation_id=...` line, same ID as the matching order-api log line | 4, 7 | ☐ |
| 54 | `saga/06-receipt-email-inbox.png` | The actual received receipt email — subject and body visible | 4, 8 | ☐ |

### WebSocket real-time push (CP-020, backend built 2026-08-18 — capture once deployed)

| # | Filename | What it must show | Task | Done |
|---|---|---|---|---|
| 55 | `tests/08-pytest-websocket-service.png` | `pytest -v` in websocket-service — 19 passed, token-verification test names legible | 4, 8 | ☐ |
| 56 | `tests/09-pytest-order-service-reconciliation.png` | order-service — 68 passed, the `payment_method`/`needs_reconciliation` tests visible | 4, 8 | ☐ |
| 57 | `terraform/06-plan-websocket-infra.png` | `terraform plan -var-file=dev.tfvars` — the WebSocket API, connections table, three Lambdas, EventBridge rules, SQS+DLQ all appearing as additions | 1, 4 | ☐ |
| 58 | `api-gateway/03-websocket-routes.png` | API Gateway → the WebSocket API → Routes: `$connect` and `$disconnect`, each with its Lambda integration | 4 | ☐ |
| 59 | `lambda/04-websocket-functions.png` | Lambda → Functions filtered on `websocket` — all three (`connect`, `disconnect`, `push-consumer`) | 4 | ☐ |
| 60 | `dynamodb/07-websocket-connections-table.png` | The connections table with a real row after connecting from the deployed frontend — `role` visible | 3, 4 | ☐ |
| 61 | `events/03-order-rules-two-targets.png` | EventBridge → the `order-confirmed`/`order-failed` rules, each now showing **two** targets (Notification's queue and the WebSocket push queue) | 4 | ☐ |
| 62 | `events/04-needs-reconciliation-rule.png` | The new `order-needs-reconciliation` rule and its target | 4, 5 | ☐ |
| 63 | `saga/07-live-stock-ticker.png` | Browser DevTools Network tab (WS filter) on a product page, showing the open WebSocket connection and a `StockUpdated` frame arriving after a reservation elsewhere | 4 | ☐ |
| 64 | `saga/08-admin-order-toast.png` | The admin dashboard at the instant an order resolves — the toast showing order ID, outcome, and payment method | 4, 8 | ☐ |

---

## Notes on specific shots

**17 — the order-api IAM policy.** The evidence is what is *absent*. The role
has no permission on the products, inventory or payments tables, so the saga
physically cannot reach around those services' APIs into their storage.
Database-per-service enforced by IAM rather than by convention.

**21 — the confirmed order.** The absence of `saga_status` is the point: a
healthy terminal state removes the attribute, which drops the item out of the
sparse recovery GSI entirely. Pair it with shot 28.

**23 — the outbox.** The absence of `status` is the relay's self-trigger
guard working: it removes the attribute on publication, so its own update
does not re-trigger it.

**30 — the X-Ray service map.** The strongest single image available: the
architecture drawn by AWS from real traffic rather than by hand. Capture it
soon after generating traffic — the default time window is short.
