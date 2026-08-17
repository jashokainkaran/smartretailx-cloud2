# SmartRetailX — Checkpoint Status
COMP60010 / ECDWA2

Verified against the actual repository state (code, `terraform state list`, `git status`,
`docs/IMPLEMENTATION_RECORD.md`) as of 2026-08-17, branch `feature/order-saga`, against the
**expanded 56-checkpoint roadmap**. Where a checkpoint's own label ("IN PROGRESS", "NEXT") disagreed
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
| ✅ CP-015 | Terraform — API Gateway | HTTP API with 8 routes, `$default` stage, access logging, throttling, X-Ray. Built as HTTP API not REST — **ADR-041 owed**. |
| ✅ CP-012 | Terraform — Network | VPC `10.0.0.0/16`, 2 private + 2 public subnets across 2 AZs, route tables, 2 security groups, 2 network ACLs, DynamoDB gateway endpoint, EventBridge interface endpoint, flow logs. No NAT gateway, by design. 6 of 7 Lambdas placed in private subnets. |
| ✅ CP-029 | Terraform — Frontend hosting | S3 (private, versioned, encrypted) + CloudFront with OAC, `/api/*` second origin, SPA error rewrites. Bucket still empty — the React build is not yet uploaded. |
| ✅ CP-016 | Terraform — WAF | Web ACL in us-east-1, scope CLOUDFRONT: common rule set, known-bad-inputs, per-IP rate limit 2000. Attached to the distribution. |

---

## In progress

| CP | Item | What's actually there | What's missing |
|---|---|---|---|
| 🟡 CP-011 | Order saga — completion and live proof | Core saga, 9 states, and 26 local tests exist. | No price-changed-at-checkout comparison, no circuit breaker, and no recorded live API Gateway confirmation/decline proof. |
| 🟡 CP-014 | Terraform — Orders + Saga deployment | Order Lambda, `order_outbox` table and second relay are applied. | Live CONFIRMED / FAILED / REJECTED proof through API Gateway remains outstanding. |
| 🟡 CP-019 | Frontend — Customer flow | Catalogue, product detail, local basket, tokenised checkout and protected order-history views are implemented locally. A separate `CustomerNavbar`/`AdminNavbar` split replaced the single conditional nav. | Run the complete checkout journey against deployed services, add UI tests, then upload the production build to S3/CloudFront. |
| 🟡 CP-021 | Cognito / RBAC | User pool, public SPA client, managed domain, `customers`/`admin` groups, automatic customer assignment, Hosted UI PKCE sign-in, the API Gateway JWT authorizer, and IAM-signed saga calls are applied. Two real bugs were found by testing the deployed admin panel (not by code review) and are now fixed **in code, not yet deployed**: (1) the frontend was sending the Cognito *access* token, which does not carry `cognito:groups` — every `require_admin`/`require_customer` check failed for every user regardless of actual role, confirmed live via CloudWatch access logs (`POST /api/v1/products` → 403 for an admin); fixed by sending the *ID* token instead. (2) `GET /api/v1/products?include_inactive=true` could never succeed because no API Gateway route attached the JWT authorizer to it; replaced with a dedicated `GET /api/v1/products/admin` route, not yet applied (`terraform plan` shows 1 pending resource). The previous "✅ Done, live-verified" status here was written before both bugs were found and has been withdrawn — see `IMPLEMENTATION_RECORD.md` §5 amendment. | Push a rebuilt `product-service` image, `terraform apply` the one pending route, then re-verify with a real admin sign-in against the deployed site (not local `npm run dev`). Separately: **zero automated test coverage exists for `require_admin`/`require_customer`/ownership checks** across all four services — every existing test bypasses auth via `AUTH_TEST_MODE`, which is exactly why bug (1) shipped past "76/76 tests passing." Worth at least one real 401/403 test per service before this is called done. |
| 🟡 CP-022 | Frontend — Admin panel | Product create/edit/activate/deactivate (now a table with a thumbnail column, per-row Edit button, and a top-level "Add product" button instead of a dropdown-driven form), stock adjustments, stuck-order and payment/refund controls, a paginated ("Load more") product list, and a dedicated Dashboard landing page (product counts, orders-needing-attention) are implemented locally, with admins auto-redirected there on sign-in. | Blocked on the same CP-021 deployment gap above — the admin panel cannot be live-tested until the `/products/admin` route and its Lambda code are actually deployed. Add UI tests and deploy the production build. |

---

## Not started

| CP | Item | Notes |
|---|---|---|
| ⬜ CP-013 | Terraform — KMS + Secrets | No `aws_kms_key`, no SSM SecureString usage. Leaves ADR-008 and ADR-019 unresolved — **on the NEVER CUT list**. |
| ⬜ CP-017 | Correlation IDs + real health checks | Every service's `/health` returns `{"status": "ok"}` unconditionally — no DynamoDB reachability check. No `correlation_id` generation or propagation anywhere in `backend/`. **On the NEVER CUT list, and explicitly time-sensitive** ("cannot be retrofitted cheaply") — worth doing before CP-025's Notification service adds a fifth consumer to thread it through. |
| ⬜ CP-018 | CI — GitHub Actions | No `.github/workflows/`. Must run backend and frontend tests, linting, dependency/security checks, Docker builds, and `terraform fmt`/`validate`/plan. |
| ⬜ CP-020 | WebSocket API + real-time push | No websocket-protocol `apigatewayv2` resource or connections table. Push stock, order-status and delivery-status events. **On the NEVER CUT list** — Task 4 requirement. |
| ⬜ CP-023 | Authenticated order status push | Depends on CP-020 and CP-021, neither started. On the cut list if time is short. |
| ⬜ CP-024 | Cash on delivery | No `payment_method`/`PENDING_ON_DELIVERY` anywhere in `order-service` (grep-confirmed). Correctly gated behind CP-019, which hasn't started. |
| ⬜ CP-025 | Notification service | `backend/services/notification-service/` contains only `.gitkeep`. Build an idempotent EventBridge/SQS/DLQ consumer for order and delivery events, with an in-app notification feed and optional email. |
| ⬜ CP-026 | Terraform — Observability | No alarms, no dashboard, no custom saga metrics in Terraform. X-Ray tracing config exists on the *unapplied* HTTP Lambdas only. **On the NEVER CUT list** (ADR-035 already promises the COMPENSATION_FAILED alarm). |
| ⬜ CP-027 | Backup and Recovery | S3 versioning and DynamoDB PITR exist, but there is no restore drill, documented backup plan, RTO/RPO, or recovery evidence. |
| ⬜ CP-028 | CD | No CI exists (CP-018), so no CD pipeline. |
| ⬜ CP-030 | Terraform — Route 53 + DR failover | No `aws_route53_*` resource. **On the NEVER CUT list** — "without it the DR story is incomplete." |
| ⬜ CP-031 | Multi-region DR demonstration | No second region, no Global Tables config. Depends on CP-030. |
| ⬜ CP-032 | Container orchestration proof | No `aws_ecs_*`, EKS, or Kubernetes manifests. Produce the assignment-required Docker plus ECS Fargate/EKS/Kubernetes proof, with deployment configuration and evidence. |
| ⬜ CP-033 | User Profile service | `backend/services/user-profile-service/` contains only `.gitkeep`. Build addresses, loyalty and GDPR-consent data, protected by customer ownership and admin access. |
| ⬜ CP-034 | Staging + production environments | Only `dev.tfvars` exists (git-ignored); no `staging.tfvars`/`production.tfvars`. |
| ⬜ CP-035 | Security testing | `docs/security/` contains only `.gitkeep`. Add JWT/auth-bypass, IDOR/customer-ownership, admin-role, input-validation, dependency and API security tests. **On the NEVER CUT list.** |
| ⬜ CP-036 | Performance/scalability testing on deployed infra | Only the local k6 oversell test exists. Measure deployed latency, throughput, error rate, concurrent users and bottlenecks, then capture graphs and analysis. |
| ⬜ CP-037 | Resilience/fault tolerance evidence | PITR is enabled (a prerequisite) but no DLQ demo, no circuit-breaker trip evidence (blocked on CP-011's circuit breaker), no restore drill, no RTO/RPO writeup. |
| ⬜ CP-038 | End-to-end application testing | Cover customer registration → browse → checkout → order/delivery updates, admin catalogue/stock/order workflows, event delivery, and authenticated API tests. |
| ⬜ CP-039 | Architecture diagrams | `infrastructure/diagrams/` contains only `.gitkeep`. |
| ⬜ CP-040 | Evidence consolidation | Same 2 screenshots. **On the NEVER CUT list** — roadmap's own "HIGHEST-RISK ITEM" callout still accurate. |
| ⬜ CP-041 | Final report | `report/` contains only `.gitkeep`. **On the NEVER CUT list.** |
| ⬜ CP-042 | Source ZIP / README | Root `README.md` exists but is only 62 lines — not yet the full deliverable README. |
| ⬜ CP-043 | Presentation slides | No slide file anywhere in the repo. |
| ⬜ CP-044 | Viva preparation | N/A until the above is further along. |
| ⬜ CP-045 | Submission audit | N/A until the above is further along. |
| ⬜ CP-046 | Deployment correctness and live smoke test | Apply and verify the Lambda IAM transactional-write permissions; prove Product → Inventory → Order → Payment confirmation and forced decline through the deployed API. |
| ⬜ CP-047 | Repeatable test environment | Make DynamoDB Local tests isolated and repeatable even when stale test tables exist; eliminate the current `OrdersTest` collision. |
| ⬜ CP-048 | Delivery tracking | Add delivery states, tracking updates and events within the Order domain, with customer and admin visibility. |
| ⬜ CP-049 | Product-price integrity | Admin product price changes remain catalogue-owned; enforce the existing checkout price-change comparison. A promotions/discount engine is deliberately out of scope. |
| ⬜ CP-050 | Global currency correctness | Store an ISO-4217 currency with product and order money values; remove the implicit USD/two-decimal global assumption. |
| ⬜ CP-051 | Frontend quality and automated tests | Add component/UI tests, accessibility checks, responsive layouts, protected routes and consistent empty/error states. |
| ⬜ CP-052 | Complete API documentation | Export Product and Order OpenAPI definitions; document auth, roles, pagination, errors and WebSocket message contracts. |
| ⬜ CP-053 | Cost governance / free-tier controls | Configure budget/credit alerts, record expected cost, document teardown, and exclude recurring-cost services unless required by assessment. |
| ⬜ CP-054 | GDPR and PCI implementation evidence | Demonstrate consent and profile controls, data minimisation/retention decisions, tokenised payment handling, and security evidence. |
| ⬜ CP-055 | CI/CD release quality gate | Run test, lint, dependency scan, Docker build, Terraform validation, deploy, smoke test and rollback/approval steps in CI/CD. |
| ⬜ CP-056 | Full end-to-end user journeys | Record and evidence complete customer and administrator journeys from sign-in through operational outcomes. |

---

## Deliberately rejected (name these in the report)

OpenSearch full-text search, ElastiCache/DAX, AWS Config, Shield Advanced, Transit
Gateway/PrivateLink, and recommendation engine. None have code or Terraform present — correctly
absent for a free-tier-aware student implementation. Multi-currency is no longer a rejected item;
it is captured by CP-050 as a global-retail correctness requirement.

---

## Notable discrepancies vs. the roadmap's own status labels

1. **CP-011's core saga is further along than "in progress" implies** — fully implemented, fully
   tested, all green. What's actually outstanding is narrowly the two named adds (price-changed
   check, circuit breaker), not the saga itself.
2. **CP-014 (orders/saga deployment) has already started** ahead of CP-012 and CP-013, which
   precede it numerically — `orders` and `payments` tables are live in AWS today, without a VPC
   (CP-012) or CMKs (CP-013) yet in front of them. Not wrong, just worth knowing the deployment
   order didn't follow the roadmap's numbering.
3. **CP-015's HTTP-API-vs-REST-API substitution is now resolved** — ADR-041 records the decision
   and its reasoning (`docs/architecture/ARCHITECTURE_DECISIONS.md`). A later migration to REST
   API was scoped and rejected: it would mean rewriting `api_gateway.tf`'s entire route model
   (REST API has no equivalent to HTTP API's `route_key` shorthand — every path segment becomes
   its own resource), updating every service's claims-reading code for the different event shape,
   re-deriving the IAM route ARNs the order saga signs against, and adding a custom domain just to
   recover the clean URL `$default` already gives for free. No net benefit was identified.
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
6. **CP-021 has been downgraded from ✅ Done back to 🟡 In progress.** The prior "Done,
   live-verified" status (and the accompanying evidence screenshots described in
   `IMPLEMENTATION_RECORD.md`'s 2026-08-17 update) predate two real bugs found by actually
   exercising the deployed admin panel: the frontend was authenticating with the wrong Cognito
   token type (access token, which carries no group membership, instead of the ID token), and
   the admin product listing route was never reachable through any authorizer-attached gateway
   route. Both are the same lesson CP-034/CP-040 already draws from Problem 10–12 above, applied
   to an application-layer feature instead of infrastructure: passing smoke checks and "looks
   configured" are not the same as verified working, and the earlier CP-021 evidence should be
   treated as superseded rather than trusted, until it is recaptured against the fixed, deployed
   code. See `IMPLEMENTATION_RECORD.md` §5 for the full amendment, including why the existing test
   suite could not have caught this (`AUTH_TEST_MODE` bypasses the exact code path that broke).

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
