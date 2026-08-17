# SmartRetailX — Checkpoint Status
COMP60010 / ECDWA2

Verified against the actual repository state (code, `terraform state list`, `git status`,
`docs/IMPLEMENTATION_RECORD.md`) as of 2026-08-17, branch `main` (`feature/order-saga` was merged
in), against the **expanded 56-checkpoint roadmap**. Where a checkpoint's own label ("IN
PROGRESS", "NEXT") disagreed with what's actually in the repo, the repo wins and the discrepancy
is noted.

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
| 🟡 CP-019 | Frontend — Customer flow | Catalogue, product detail, local basket, protected order-history, and a full checkout form: delivery address, contact email/phone, card-or-cash-on-delivery selector (styled as selectable cards, not raw radios), and live client-side validation on every field plus a top-level "N fields need attention" summary. Card payment tokenises in the browser (a mock, not a real PSP integration — no card number ever reaches the backend). A separate `CustomerNavbar`/`AdminNavbar` split, both with a mobile hamburger menu (the desktop nav was `hidden md:flex` with **no fallback at all** below 768px, found and fixed). **A large second round, built and tested but not yet committed or deployed as of this writing** (`git status` — 20 files, all under `frontend/src/`): a cart icon with a live numeric badge (replacing "Basket (3)" text); order-history pagination; out-of-stock shown both as a card badge and as red text in the card body, with the "Add" button disabled and correctly greyed (caught and fixed a real contrast bug — white text on light-gray background — while doing this); an "Add to cart" button directly on the product grid (required restructuring the card off a `<button>` wrapper, since nesting a real button inside it is invalid HTML — now a clickable `<article>` with a separate button that stops both click *and* keydown propagation, the latter catching a real keyboard-accessibility bug before it shipped); a toast notification on add-to-cart, which also **changed a behaviour**: adding an item no longer auto-navigates to the cart page (that made adding a 2nd/3rd item disruptive); product images and a subtotal added to the basket item list; the checkout form's sign-in requirement moved from blocking the form outright to validating first and, only for a genuinely complete order, saving a draft to `sessionStorage` and returning the user to a filled-in form after the Cognito redirect (address/contact/payment-method persist across the round trip; card fields deliberately do not); and a consistent status-page system (`StatusPage`/`StatusIcon`) now backing the API-error, access-denied, and "page not found" states, plus a genuine 404 for unrecognised routes (previously silently redirected to the shop with no explanation). | Commit and deploy this second round, then a live checkout run end-to-end against the deployed site. Add UI tests (CP-051, still zero). |
| 🟡 CP-021 | Cognito / RBAC | User pool, public SPA client, managed domain, `customers`/`admin` groups, automatic customer assignment, Hosted UI PKCE sign-in, the API Gateway JWT authorizer, and IAM-signed saga calls are applied. The two bugs from the previous revision of this file (wrong Cognito token type; the missing `/products/admin` authorizer route) are fixed and deployed, confirmed via `terraform plan` ("No changes"), matching Lambda `CodeSha256` values, and live `curl` checks (`GET /products` → 200, `GET /products/admin` → 401, `POST /orders` → 401, all before Lambda is invoked). A **third** bug — the deployed admin dashboard rendering blank after sign-in — was root-caused (pre-existing orders lack the new checkout fields the `Order` response model had made required) and fixed; `order-api`'s Lambda digest and the S3 bucket both show a redeploy timestamp consistent with this fix having gone out, but **no one has actually clicked through the live admin dashboard since to confirm it renders** — treat as fixed-but-unconfirmed, not fixed-and-verified, until that happens. | Have a real admin sign in against the deployed site and confirm the dashboard actually renders. Separately, still open: **zero automated test coverage for `require_admin`/`require_customer`/ownership checks** — every test bypasses auth via `AUTH_TEST_MODE`, which is why the token-type bug shipped past "76/76 passing" in the first place. |
| 🟡 CP-024 | Cash on delivery | `PENDING_ON_DELIVERY` is a genuinely new terminal state (`states.py`), deliberately not a reuse of `PENDING` — that's an in-flight, milliseconds-scale state, and collapsing the two would make a working COD order indistinguishable from a crashed saga. `OrderCreate`/`Order` carry `payment_method`, and the saga branches right after stock reservation: card takes the existing charge/confirm/compensate path unchanged; COD skips straight to confirming stock, and a confirm failure goes straight to `FAILED` since nothing was ever charged to refund. 9 new tests (happy path, event payload, stays out of the stuck-order index, oversell prevention still applies, confirm-failure with nothing to compensate, confirm-timeout, card-without-token rejected, COD-without-token accepted, malformed email rejected). Frontend: the checkout form's payment-method selector, deployed. | Live-verify an actual cash-on-delivery order through the deployed site (same blockage as CP-021/CP-022 above). |
| 🟡 CP-022 | Frontend — Admin panel | Product create/edit/activate/deactivate (a table with a thumbnail column, per-row Edit button, and a top-level "Add product" button — the old dropdown-driven single form is gone), stock adjustments, stuck-order and payment/refund controls, a paginated ("Load more") product list, and a dedicated Dashboard landing page (product counts, orders-needing-attention), with admins auto-redirected there on sign-in and a mobile hamburger nav. Deployed as of the last confirmed sync. | The CP-021 blank-dashboard bug above is specifically in this surface — cannot be called live-verified until confirmed by an actual admin session. Add UI tests. |

---

## Not started

| CP | Item | Notes |
|---|---|---|
| ⬜ CP-013 | Terraform — KMS + Secrets | No `aws_kms_key`, no SSM SecureString usage. Leaves ADR-008 and ADR-019 unresolved — **on the NEVER CUT list**. |
| ⬜ CP-017 | Correlation IDs + real health checks | Every service's `/health` returns `{"status": "ok"}` unconditionally — no DynamoDB reachability check. No `correlation_id` generation or propagation anywhere in `backend/`. **On the NEVER CUT list, and explicitly time-sensitive** ("cannot be retrofitted cheaply") — worth doing before CP-025's Notification service adds a fifth consumer to thread it through. |
| ⬜ CP-018 | CI — GitHub Actions | No `.github/workflows/`. Must run backend and frontend tests, linting, dependency/security checks, Docker builds, and `terraform fmt`/`validate`/plan. |
| ⬜ CP-020 | WebSocket API + real-time push | No websocket-protocol `apigatewayv2` resource or connections table. Push stock, order-status and delivery-status events. **On the NEVER CUT list** — Task 4 requirement. |
| ⬜ CP-023 | Authenticated order status push | Depends on CP-020, still not started, and CP-021, now applied. On the cut list if time is short. |
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
7. **`main` was briefly broken by an operational mistake, unrelated to any code decision, and is
   now fixed.** Two `git add .` runs from the repo root (not `frontend/`) swept up local
   package-manager caches that had no business being tracked — `.pnpm-store/` (which happened to
   contain a full duplicate copy of the frontend project) and later `frontend/.vite/` (Vite's dev
   cache, ~25,000 lines of bundled React internals). Somewhere between those two commits, 9 real
   files were deleted from disk — `index.html`, `package.json`, `package-lock.json`,
   `tailwind.config.js`, `postcss.config.js`, `src/index.css`, and three base components
   (`ErrorState.jsx`, `ImagePlaceholder.jsx`, `LoadingState.jsx`) — and that deletion got
   committed as fact. `main` could not build at all in that state. Restored all 9 files from the
   last commit that had them intact, removed both cache directories from tracking, and added
   `.pnpm-store/`/`.vite/` to `.gitignore` at both the root and `frontend/` level so this specific
   mistake can't recur. Confirmed fixed with an actual `npm run build` from a wiped `dist/`, not
   just a git diff. Worth naming for CP-034/CP-040 the same way discrepancy 5 already does: a
   `git commit` succeeding is not evidence the result builds.
8. **The full backend deployment pipeline is now verified end-to-end, not just applied.** After
   `terraform apply`, checked `terraform plan` again (clean), pulled both Lambdas'
   `CodeSha256` directly and confirmed they match the digests actually pushed to ECR, and ran live
   `curl` checks against the real API Gateway URL confirming both the public route and the
   previously-missing admin route behave correctly. This is the same "plan returns no changes,
   not just applied cleanly" standard discrepancy 5 sets for infrastructure, now met for an
   application-layer deploy too.
9. **A second, larger round of frontend work exists only locally as of this writing** — cart
   icon/badge, order-history pagination, out-of-stock indicators and grid-level add-to-cart,
   a toast notification (which changed add-to-cart's behaviour — no longer auto-navigates to the
   basket), checkout page images/subtotal, the sign-in-mid-checkout draft-persistence redesign,
   and a consistent status-page system covering 404/access-denied/crash states. All of it builds
   clean and was verified piece by piece, but `git status` shows 20 files still uncommitted, and
   there's no confirmation this batch has been deployed. Same discipline as discrepancy 5 and 7:
   "built and tested" is not "shipped" — don't count this toward CP-019/CP-022 as live until a
   commit, a deploy, and an actual click-through all happen.

## Update — network and edge complete

Since the checkpoint above was written, CP-011, CP-012, CP-014, CP-015,
CP-016 and CP-029 have all been completed.

**ADR-041 is now written** (`docs/architecture/ARCHITECTURE_DECISIONS.md`) — HTTP API over REST
API, including the later-scoped-and-rejected REST API migration (see discrepancy 3 above). Note
that file is in `.gitignore` ("internal planning docs, excluded by choice") — a deliberate
decision, not an oversight, but worth remembering if the report needs to cite it directly rather
than by reference.

**ADRs still owed** (decisions taken but not yet recorded):

- **ADR-042** — no NAT gateway; private subnets with no default route.
  Includes why `order-api` is the single function left outside the VPC.
- **ADR-043** — network ACLs alongside security groups as a stateless second
  layer, and the gateway-endpoint addressing trap that constrains both.

**Verification still outstanding on the deployed network:** after the apply,
place one order and confirm the `order-outbox` record loses its `status`
attribute. A Lambda in a private subnet that cannot resolve EventBridge does
not error — it hangs until timeout, so a successful apply is not evidence
that the interface endpoint resolves.
