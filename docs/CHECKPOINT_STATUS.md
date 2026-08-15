# SmartRetailX — Checkpoint Status
COMP60010 / ECDWA2

Verified against the actual repository state (code, `terraform state list`, `git status`,
`docs/IMPLEMENTATION_RECORD.md`) as of 2026-08-15, branch `feature/order-saga`, against the
**final 45-checkpoint roadmap**. Where a checkpoint's own label ("IN PROGRESS", "NEXT") disagreed
with what's actually in the repo, the repo wins and the discrepancy is noted.

Legend: ✅ Done &nbsp;·&nbsp; 🟡 In progress &nbsp;·&nbsp; ⬜ Not started

---

## Complete

| CP | Item | Verified by |
|---|---|---|
| ✅ CP-001 | Project baseline / governance | `docs/PROJECT_BRIEF.md`, git history |
| ✅ CP-002 | Product Catalogue service | `backend/services/product-service`, 16 tests |
| ✅ CP-003 | Inventory service, oversell prevention | `backend/services/inventory-service`, 20 tests, k6 local test |
| ✅ CP-004 | Payment service, tokenisation | `backend/services/payment-service`, 14 tests |
| ✅ CP-005 | Terraform foundation | `terraform/main.tf`, `variables.tf` |
| ✅ CP-006 | Terraform — DynamoDB (Streams, sparse GSI, TTL, PITR) | in `terraform state list` |
| ✅ CP-007 | Terraform — Eventing (bus, SQS, DLQ, rule, queue policy) | in `terraform state list` |
| ✅ CP-008 | Terraform — ECR (scan-on-push, lifecycle) | in `terraform state list` |
| ✅ CP-009 | Terraform — Lambda (relay + inventory consumer) | in `terraform state list`, both deployed |
| ✅ CP-010 | Transactional outbox end-to-end, self-trigger guard | AWS-verified, `IMPLEMENTATION_RECORD.md` §3 |
| ✅ CP-011 | Order Service + Saga | 9 states, rejected/unknown split, 26 tests, deployed and proven on AWS. Circuit breaker and price-change check deferred — see below. |
| ✅ CP-014 | Terraform — Orders + Saga deployment | Order Lambda, `order_outbox` table and second relay all applied; CONFIRMED / FAILED / REJECTED proven against the deployed API. |
| ✅ CP-015 | Terraform — API Gateway | HTTP API with 8 routes, `$default` stage, access logging, throttling, X-Ray. Built as HTTP API not REST — **ADR-041 owed**. |
| ✅ CP-012 | Terraform — Network | VPC `10.0.0.0/16`, 2 private + 2 public subnets across 2 AZs, route tables, 2 security groups, 2 network ACLs, DynamoDB gateway endpoint, EventBridge interface endpoint, flow logs. No NAT gateway, by design. 6 of 7 Lambdas placed in private subnets. |
| ✅ CP-029 | Terraform — Frontend hosting | S3 (private, versioned, encrypted) + CloudFront with OAC, `/api/*` second origin, SPA error rewrites. Bucket still empty — the React build is not yet uploaded. |
| ✅ CP-016 | Terraform — WAF | Web ACL in us-east-1, scope CLOUDFRONT: common rule set, known-bad-inputs, per-IP rate limit 2000. Attached to the distribution. |

---

## In progress

| CP | Item | What's actually there | What's missing |
|---|---|---|---|
| 🟡 CP-011 | Order saga — the two named adds | Saga itself complete and deployed. | No price-changed-at-checkout comparison; no circuit breaker on the downstream HTTP calls (timeout exists, no failure-counter/trip logic). |

---

## Not started

| CP | Item | Notes |
|---|---|---|
| ⬜ CP-013 | Terraform — KMS + Secrets | No `aws_kms_key`, no SSM SecureString usage. Leaves ADR-008 and ADR-019 unresolved — **on the NEVER CUT list**. |
| ⬜ CP-017 | Correlation IDs + real health checks | Every service's `/health` returns `{"status": "ok"}` unconditionally — no DynamoDB reachability check. No `correlation_id` generation or propagation anywhere in `backend/`. **On the NEVER CUT list, and explicitly time-sensitive** ("cannot be retrofitted cheaply") — worth doing before CP-025's Notification service adds a fifth consumer to thread it through. |
| ⬜ CP-018 | CI — GitHub Actions | No `.github/workflows/` in the repo (only inside `frontend/node_modules`, irrelevant). No `pip-audit`, no `terraform fmt`/`validate` check. |
| ⬜ CP-019 | Frontend — Customer flow | `frontend/src/` is a read-only product grid + detail view only. No cart, no checkout, no saga call, no payment token selector, no order history. **On the NEVER CUT list** — "without it the demo is Swagger." |
| ⬜ CP-020 | WebSocket API + live stock push | No websocket-protocol `apigatewayv2` resource, no connections table. **On the NEVER CUT list** — Task 4's first named requirement. |
| ⬜ CP-021 | Cognito / RBAC | No `aws_cognito_*` resource; confirmed in `IMPLEMENTATION_RECORD.md` §5 — every endpoint is open, no JWT validation anywhere. **On the NEVER CUT list** — "Task 3 is 40% of the implementation mark and is currently unbuilt." |
| ⬜ CP-022 | Frontend — Admin panel | No admin component/route in `frontend/src/`. |
| ⬜ CP-023 | Authenticated order status push | Depends on CP-020 and CP-021, neither started. On the cut list if time is short. |
| ⬜ CP-024 | Cash on delivery | No `payment_method`/`PENDING_ON_DELIVERY` anywhere in `order-service` (grep-confirmed). Correctly gated behind CP-019, which hasn't started. |
| ⬜ CP-025 | Notification service | `backend/services/notification-service/` contains only `.gitkeep`. |
| ⬜ CP-026 | Terraform — Observability | No alarms, no dashboard, no custom saga metrics in Terraform. X-Ray tracing config exists on the *unapplied* HTTP Lambdas only. **On the NEVER CUT list** (ADR-035 already promises the COMPENSATION_FAILED alarm). |
| ⬜ CP-027 | Terraform — Backup and Recovery | No `aws_backup_vault`/plan, no S3 versioning (no S3 bucket exists yet at all — see CP-029). |
| ⬜ CP-028 | CD | No CI exists (CP-018), so no CD pipeline. |
| ⬜ CP-030 | Terraform — Route 53 + DR failover | No `aws_route53_*` resource. **On the NEVER CUT list** — "without it the DR story is incomplete." |
| ⬜ CP-031 | Multi-region DR demonstration | No second region, no Global Tables config. Depends on CP-030. |
| ⬜ CP-032 | Terraform — ECS Fargate proof | No `aws_ecs_*` resource. First on the cut-if-short list. |
| ⬜ CP-033 | User Profile service | `backend/services/user-profile-service/` contains only `.gitkeep`. Fourth on the cut-if-short list. |
| ⬜ CP-034 | Staging + production environments | Only `dev.tfvars` exists (git-ignored); no `staging.tfvars`/`production.tfvars`. |
| ⬜ CP-035 | Security testing | `docs/security/` contains only `.gitkeep`. No IDOR test, no auth-bypass test — none of it is possible yet since CP-021 (Cognito) doesn't exist. **On the NEVER CUT list.** |
| ⬜ CP-036 | Performance/scalability testing on deployed infra | Only the local k6 oversell test exists; never run against deployed infra. Second on the cut-if-short list. |
| ⬜ CP-037 | Resilience/fault tolerance evidence | PITR is enabled (a prerequisite) but no DLQ demo, no circuit-breaker trip evidence (blocked on CP-011's circuit breaker), no restore drill, no RTO/RPO writeup. |
| ⬜ CP-038 | End-to-end API testing | `evidence/screenshots/` has exactly 2 images, both under `product-service/`. |
| ⬜ CP-039 | Architecture diagrams | `infrastructure/diagrams/` contains only `.gitkeep`. |
| ⬜ CP-040 | Evidence consolidation | Same 2 screenshots. **On the NEVER CUT list** — roadmap's own "HIGHEST-RISK ITEM" callout still accurate. |
| ⬜ CP-041 | Final report | `report/` contains only `.gitkeep`. **On the NEVER CUT list.** |
| ⬜ CP-042 | Source ZIP / README | Root `README.md` exists but is only 62 lines — not yet the full deliverable README. |
| ⬜ CP-043 | Presentation slides | No slide file anywhere in the repo. |
| ⬜ CP-044 | Viva preparation | N/A until the above is further along. |
| ⬜ CP-045 | Submission audit | N/A until the above is further along. |

---

## Deliberately rejected (name these in the report)

OpenSearch full-text search, ElastiCache/DAX, AWS Config, Shield Advanced, Transit
Gateway/PrivateLink, customer order cancellation, recommendation engine, multi-currency. None of
these have any code or Terraform present — correctly absent, nothing to reconcile.

---

## Notable discrepancies vs. the roadmap's own status labels

1. **CP-011's core saga is further along than "in progress" implies** — fully implemented, fully
   tested, all green. What's actually outstanding is narrowly the two named adds (price-changed
   check, circuit breaker), not the saga itself.
2. **CP-014 (orders/saga deployment) has already started** ahead of CP-012 and CP-013, which
   precede it numerically — `orders` and `payments` tables are live in AWS today, without a VPC
   (CP-012) or CMKs (CP-013) yet in front of them. Not wrong, just worth knowing the deployment
   order didn't follow the roadmap's numbering.
3. **CP-015 made an architectural substitution that needs a decision**: the in-progress work
   builds an HTTP API (apigatewayv2), but this checkpoint explicitly asks for a REST API — the
   two are not interchangeable (request validation, usage plans, and API keys are REST-API-only
   features this checkpoint names). Either migrate it or write an ADR justifying HTTP API instead
   before claiming this checkpoint complete.
4. **CP-017 (correlation IDs) is still unstarted** despite the roadmap's own warning to do it
   before more services exist — CP-025 (Notification) will be the fifth consumer to retrofit it
   across if it's deferred further.
5. **CP-012, CP-016 and CP-029 are now fully applied and verified — this was not true at first
   apply.** The VPC/subnets/route tables/security groups/NACLs/VPC endpoints/flow logs/WAF, and
   the S3+CloudFront hosting stack, are confirmed live in AWS as of 2026-08-15 (real IDs in
   `IMPLEMENTATION_RECORD.md` §4, `terraform plan` returns `No changes.`). Two things had to be
   caught and fixed after the first apply, both recorded in `IMPLEMENTATION_RECORD.md` §7: the
   six in-VPC Lambdas' `vpc_config` attachment did not show in the same plan that created the
   network and needed a second apply to land (Problem 10); the frontend S3 bucket name collided
   with a bucket owned by an unrelated AWS account and had to be suffixed with the account ID
   (Problem 11); and a `viewer_certificate` misconfiguration caused CloudFront to drift on every
   subsequent plan until fixed (Problem 12). Worth keeping in mind for CP-034/CP-040: a clean
   `apply` on first try is not sufficient evidence a checkpoint is genuinely complete — a
   follow-up `plan` with zero changes is.

## Uncommitted work in progress right now (branch `feature/order-saga`)

- Modified: `lambda_inventory_consumer.tf`, `lambda_relay.tf`, `order_outbox.tf`, `outputs.tf`,
  `variables.tf`
- New, untracked: `api_gateway.tf`, `lambda_http_services.tf`, `docs/api/inventory-service.openapi.json`,
  `docs/api/payment-service.openapi.json`, `scripts/create_order_outbox_table.py`,
  `scripts/deploy-images.ps1`

None of this has been `terraform apply`'d yet — `terraform state list` does not contain the order
Lambda, the four new HTTP Lambdas, the API Gateway, or the `order_outbox` table.


---

## Update — network and edge complete

Since the checkpoint above was written, CP-011, CP-012, CP-014, CP-015,
CP-016 and CP-029 have all been completed.

**ADRs now owed** (decisions taken but not yet recorded):

- **ADR-041** — HTTP API over REST API. The substitution is defensible:
  request validation is redundant against Pydantic, usage plans and API keys
  exist for metering third-party consumers that do not exist here, HTTP API
  is materially cheaper and lower latency, and its **native JWT authorizer**
  makes the coming Cognito work simpler rather than harder. The one genuine
  loss is that WAFv2 cannot attach to an HTTP API — resolved by fronting it
  with CloudFront, which was being added for the frontend regardless.
- **ADR-042** — no NAT gateway; private subnets with no default route.
  Includes why `order-api` is the single function left outside the VPC.
- **ADR-043** — network ACLs alongside security groups as a stateless second
  layer, and the gateway-endpoint addressing trap that constrains both.

**Verification still outstanding on the deployed network:** after the apply,
place one order and confirm the `order-outbox` record loses its `status`
attribute. A Lambda in a private subnet that cannot resolve EventBridge does
not error — it hangs until timeout, so a successful apply is not evidence
that the interface endpoint resolves.
