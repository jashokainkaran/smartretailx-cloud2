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
| ✅ CP-024 | Cash on delivery | `PENDING_ON_DELIVERY` terminal state (`states.py`), `OrderCreate`/`Order` carry `payment_method`, saga branches after stock reservation (card path unchanged; COD skips charge/confirm-with-refund entirely, a confirm failure goes straight to `FAILED`). 9 tests. **Live-verified 2026-08-17**: a real COD order placed against the deployed site, correctly appearing on My Orders — see `IMPLEMENTATION_RECORD.md`'s "systemic RBAC bug" update for the CP-021 fix this depended on. |

---

## In progress

| CP | Item | What's actually there | What's missing |
|---|---|---|---|
| 🟡 CP-011 | Order saga — completion and live proof | Core saga, 9 states, and 26 local tests exist. | No price-changed-at-checkout comparison, no circuit breaker, and no recorded live API Gateway confirmation/decline proof. |
| 🟡 CP-014 | Terraform — Orders + Saga deployment | Order Lambda, `order_outbox` table and second relay are applied. | Live CONFIRMED / FAILED / REJECTED proof through API Gateway remains outstanding. |
| 🟡 CP-019 | Frontend — Customer flow | Catalogue, product detail, local basket, protected order-history, and a full checkout form: delivery address, contact email/phone, card-or-cash-on-delivery selector (styled as selectable cards, not raw radios), and live client-side validation on every field plus a top-level "N fields need attention" summary. Card payment tokenises in the browser (a mock, not a real PSP integration — no card number ever reaches the backend). A separate `CustomerNavbar`/`AdminNavbar` split, both with a mobile hamburger menu (the desktop nav was `hidden md:flex` with **no fallback at all** below 768px, found and fixed). **A large second round, committed and deployed 2026-08-18** (was previously built and tested but sitting uncommitted — now pushed and live): a cart icon with a live numeric badge (replacing "Basket (3)" text); order-history pagination; out-of-stock shown both as a card badge and as red text in the card body, with the "Add" button disabled and correctly greyed (caught and fixed a real contrast bug — white text on light-gray background — while doing this); an "Add to cart" button directly on the product grid (required restructuring the card off a `<button>` wrapper, since nesting a real button inside it is invalid HTML — now a clickable `<article>` with a separate button that stops both click *and* keydown propagation, the latter catching a real keyboard-accessibility bug before it shipped); a toast notification on add-to-cart, which also **changed a behaviour**: adding an item no longer auto-navigates to the cart page (that made adding a 2nd/3rd item disruptive); product images and a subtotal added to the basket item list; the checkout form's sign-in requirement moved from blocking the form outright to validating first and, only for a genuinely complete order, saving a draft to `sessionStorage` and returning the user to a filled-in form after the Cognito redirect (address/contact/payment-method persist across the round trip; card fields deliberately do not); and a consistent status-page system (`StatusPage`/`StatusIcon`) now backing the API-error, access-denied, and "page not found" states, plus a genuine 404 for unrecognised routes (previously silently redirected to the shop with no explanation). | Committed, deployed, and the checkout flow itself has been exercised live repeatedly (COD, RBAC testing). Not yet done: a deliberate feature-by-feature click-through of the newer specific UI (cart badge increments, toast timing, keyboard accessibility on grid add-to-cart) — deployed and building clean is confirmed, each individual interaction is not. UI tests now exist (CP-051) but only for `ProductCard`/`ProductImage` — none yet for this page's own newer UI specifically. |
| 🟡 CP-021 | Cognito / RBAC | User pool, public SPA client, managed domain, `customers`/`admin` groups, automatic customer assignment, Hosted UI PKCE sign-in, the API Gateway JWT authorizer, and IAM-signed saga calls are applied. The two bugs from the previous revision of this file (wrong Cognito token type; the missing `/products/admin` authorizer route) are fixed and deployed. A **fourth** bug — the biggest one found in this project so far — was found and fixed 2026-08-17: API Gateway's JWT authorizer forwards a single-group `cognito:groups` claim as the bracket-wrapped string `"[customers]"`, and every service's `groups()` split naively on `,`, leaving the brackets attached — so `require_customer`/`require_admin` silently rejected **every real Cognito sign-in in production**, not a COD-specific or account-specific issue. Fixed identically across all four services, covered by 4 new regression tests each (`tests/test_auth.py`), redeployed, and confirmed with a live cash-on-delivery checkout that correctly reached `require_customer`. Full details, including two unrelated bugs found while fixing this one, in `IMPLEMENTATION_RECORD.md`'s 2026-08-17 "systemic RBAC bug" update. | The admin dashboard blank-render bug (third bug, below) still has not been re-confirmed by an actual click-through since its fix — separate from the RBAC parsing bug and still open. Test coverage is improved (`groups()` itself is now regression-tested against the real claim shape) but `require_admin`/`require_customer` end-to-end through a realistic API-Gateway-shaped request still has no automated test — only `groups()` in isolation. |
| 🟡 CP-048 | Delivery tracking | New `delivery_status` field on `Order` (`PROCESSING`/`SHIPPED`/`OUT_FOR_DELIVERY`/`DELIVERED`), settable only on a `CONFIRMED`/`PENDING_ON_DELIVERY` order via admin-only `PATCH /api/v1/orders/{order_id}/delivery-status`. A new admin-wide order listing (`GET /api/v1/orders/admin`, backed by a real GSI — `all-orders-index`, a constant-partition-key pattern, not a Scan) and a `CustomersOrdersPage.jsx` frontend give admins full visibility and a way to set it, grouped by customer via the `contact_email`/`contact_phone` already captured at checkout. | **Customer-side visibility does not exist yet** — `OrdersPage.jsx` (the customer's own order history) does not render `delivery_status` at all, so a customer cannot see their own delivery progress despite the data being tracked. No delivery *events* (an audit trail of status changes over time) either — just the current value, overwritable with no history. |
| 🟡 CP-018 | CI — GitHub Actions | `.github/workflows/ci.yml`, real and running against the actual GitHub repository (not just written, verified green on a live push): per-service backend test matrix (`product`/`inventory`/`payment`/`order`, each against a real DynamoDB Local service container), a frontend build check, `terraform fmt -check`/`validate`, a Docker build sanity check for all five deployable images, and dependency vulnerability scanning (`pip-audit` per backend service, `npm audit` for the frontend, scoped to production dependencies — see below). Deliberately `permissions: contents: read` — it can verify, it cannot deploy (no AWS credentials given to it at all). | No `terraform plan` against real state (would need AWS credentials in CI, a deliberate scope boundary, not an oversight) and no explicit linting step for either language. CP-028 (CD) still depends on this and remains unstarted — CI proves a change is safe, it does not yet ship it. |
| 🟡 CP-057 | Integration testing | Every backend service's existing test suite (`test_orders.py`, `test_inventory.py`, `test_products.py`, `test_payments.py`) already *is* integration-level testing, in substance, even though nothing in this project explicitly labelled it that way before now: FastAPI's `TestClient` drives real routing and real dependency injection against a real DynamoDB Local instance, with only the external service-to-service HTTP boundaries replaced by in-memory doubles. Never previously tracked as its own checkpoint — folded silently into each service's own line (CP-002/003/004/CP-011) instead. | Closed for auth specifically: `tests/test_security.py` (see CP-035) now exists in all four services and is the first integration coverage that exercises the real Mangum handler with a genuine API-Gateway-shaped event and `AUTH_TEST_MODE` actually off, rather than bypassed. Still no integration coverage for the saga against real HTTP services generally (`clients.py`'s own status-code mapping is only exercised indirectly, per §2.5's own "Not tested" note) — that gap is unrelated to auth and remains open. |
| 🟡 CP-035 | Security testing | `tests/test_security.py` added to all four backend services (21 tests total: 12 order-service, 3 each for product/inventory/payment — after a critical self-review pass, see below), each calling the real Mangum Lambda handler directly with hand-built API-Gateway-shaped events and `AUTH_TEST_MODE` genuinely disabled via `monkeypatch` — the first tests in this project to exercise the actual claims-parsing path rather than the hardcoded bypass. Covers: **auth-bypass** (no claims at all, claims present but no `sub`), **admin-role enforcement** (customer group rejected on admin-only routes; the exact bracket-string claim shape that caused the systemic RBAC bug now passes end-to-end, not just in `groups()` isolation, on every admin route including the two newest — `GET /orders/admin`, `PATCH /orders/{id}/delivery-status`), and **IDOR/ownership** on order-service specifically (a customer cannot read another customer's order by ID — 404, not 403, matching the deliberate existence-hiding design; an admin can; the owner can). Every rejection assertion checks the response body's `detail` message, not just the status code, after a self-review found status-code-only checks could pass for the wrong reason (some unrelated 403 elsewhere, not necessarily `require_admin`). All 21 pass, full suites remain green (order 57/57, product 24/24, inventory 27/27, payment 21/21). | **Not "done," and shouldn't be marked as such:** these are integration tests against the app — they call the Lambda handler directly, so they can only test what happens *after* API Gateway's JWT authorizer already let a request through. They cannot and do not test token expiry, signature validation, or issuer/audience mismatches — the exact class of bug behind the CORS-masked-401 debugged live earlier the same session. Closing that gap needs a genuine end-to-end test against the real deployed API Gateway, not more of this test type. Also still open: input-validation/dependency-scan tests live elsewhere rather than here (verified, not just asserted — `test_orders.py` alone already has several); no IDOR tests for product/inventory/payment (no per-customer ownership concept exists there to test); and `docs/security/` is still just `.gitkeep` — no written security test *plan* or threat-model document, only the tests themselves. |
| 🟡 CP-051 | Frontend quality and automated tests | Vitest + React Testing Library set up from scratch (`vite.config.js`'s `test` block, `src/test/setup.js`), now wired into `.github/workflows/ci.yml`'s frontend job (`npm test` runs before `npm run build`). First real component tests: `ProductImage.test.jsx` (3 tests — a direct regression test for the broken-image-URL bug found live this session: real image renders, no `src` shows the placeholder, and a failed image load falls back to the placeholder rather than a permanent broken icon) and `ProductCard.test.jsx` (6 tests — stock-based Add button enable/disable, the 404-vs-500 distinction in the out-of-stock logic, and that clicking Add doesn't also open the product via event propagation). Hit and fixed two real tooling issues, not test-code issues, on the very first run: Vitest's default "forks" process pool timed out starting workers in this environment (switched to `pool: "threads"`), and React Testing Library needs an explicit `afterEach(cleanup)` under Vitest — it isn't automatic the way it is under Jest, and every test silently saw leftover DOM from the previous one until this was added. All 9 tests pass, production build unaffected (test files are naturally excluded, nothing extra needed). | Two components with real, meaningful behaviour, not the whole frontend — no tests yet for `CartPage` (form validation, payment-method switching), `CustomersOrdersPage` (delivery-status dropdown gating), `AdminPanel`, or any routing/navigation logic. No accessibility-specific checks (e.g. axe). No responsive-layout tests. |
| 🟡 CP-022 | Frontend — Admin panel | Product create/edit/activate/deactivate (a table with a thumbnail column, per-row Edit button, and a top-level "Add product" button — the old dropdown-driven single form is gone), stock adjustments, stuck-order and payment/refund controls, a paginated ("Load more") product list, and a dedicated Dashboard landing page (product counts, orders-needing-attention), with admins auto-redirected there on sign-in and a mobile hamburger nav. Deployed as of the last confirmed sync. | The CP-021 blank-dashboard bug above is specifically in this surface — cannot be called live-verified until confirmed by an actual admin session. Add UI tests. |

---

## Not started

| CP | Item | Notes |
|---|---|---|
| ⬜ CP-013 | Terraform — KMS + Secrets | No `aws_kms_key`, no SSM SecureString usage. Leaves ADR-008 and ADR-019 unresolved — **on the NEVER CUT list**. |
| ⬜ CP-017 | Correlation IDs + real health checks | Every service's `/health` returns `{"status": "ok"}` unconditionally — no DynamoDB reachability check. No `correlation_id` generation or propagation anywhere in `backend/`. **On the NEVER CUT list, and explicitly time-sensitive** ("cannot be retrofitted cheaply") — worth doing before CP-025's Notification service adds a fifth consumer to thread it through. |
| ⬜ CP-020 | WebSocket API + real-time push | No websocket-protocol `apigatewayv2` resource or connections table. Push stock, order-status and delivery-status events. **On the NEVER CUT list** — Task 4 requirement. |
| ⬜ CP-023 | Authenticated order status push | Depends on CP-020, still not started, and CP-021, now applied. On the cut list if time is short. |
| ⬜ CP-025 | Notification service | `backend/services/notification-service/` contains only `.gitkeep`. Build an idempotent EventBridge/SQS/DLQ consumer for order and delivery events, with an in-app notification feed and optional email. |
| ⬜ CP-026 | Terraform — Observability | No alarms, no dashboard, no custom saga metrics in Terraform. X-Ray tracing config exists on the *unapplied* HTTP Lambdas only. **On the NEVER CUT list** (ADR-035 already promises the COMPENSATION_FAILED alarm). |
| ⬜ CP-027 | Backup and Recovery | S3 versioning and DynamoDB PITR exist, but there is no restore drill, documented backup plan, RTO/RPO, or recovery evidence. |
| ⬜ CP-028 | CD | CI now exists (CP-018), but nothing consumes a green run to actually deploy — every deploy so far has been a manual `docker build`/`push` + `terraform apply` + `aws s3 sync` sequence, run by hand. |
| ⬜ CP-030 | Terraform — Route 53 + DR failover | No `aws_route53_*` resource. **On the NEVER CUT list** — "without it the DR story is incomplete." |
| ⬜ CP-031 | Multi-region DR demonstration | No second region, no Global Tables config. Depends on CP-030. |
| ⬜ CP-032 | Container orchestration proof | No `aws_ecs_*`, EKS, or Kubernetes manifests. Produce the assignment-required Docker plus ECS Fargate/EKS/Kubernetes proof, with deployment configuration and evidence. |
| ⬜ CP-033 | User Profile service | `backend/services/user-profile-service/` contains only `.gitkeep`. Build addresses, loyalty and GDPR-consent data, protected by customer ownership and admin access. |
| ⬜ CP-034 | Staging + production environments | Only `dev.tfvars` exists (git-ignored); no `staging.tfvars`/`production.tfvars`. |
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
| ⬜ CP-047 | Repeatable test environment | Make DynamoDB Local tests isolated and repeatable even when stale test tables exist; eliminate the current `OrdersTest` collision. **A second, related fragility found 2026-08-17** (discrepancy 10): each service's real test file sets `DYNAMODB_ENDPOINT`/test table names via a module-level `os.environ` assignment that only works if that file is the first thing pytest imports — adding `tests/test_auth.py` (which sorts alphabetically first) broke this in all four services until it was given the same assignment. A `conftest.py` fixture per service would remove the ordering dependency entirely instead of requiring every new test file to know about it. |
| ⬜ CP-049 | Product-price integrity | Admin product price changes remain catalogue-owned; enforce the existing checkout price-change comparison. A promotions/discount engine is deliberately out of scope. |
| ⬜ CP-050 | Global currency correctness | Store an ISO-4217 currency with product and order money values; remove the implicit USD/two-decimal global assumption. |
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
10. **The single biggest correctness bug found in this project so far, and it was RBAC, not COD.**
    A report that a cash-on-delivery order wasn't showing on My Orders led — via live CloudWatch
    logs and a direct `aws dynamodb scan`, not code reading — to discovering that API Gateway's
    JWT authorizer forwards a single-group `cognito:groups` claim as the string `"[customers]"`,
    brackets included, and every service's `groups()` split naively on `,`. For any account with
    exactly one group (every real account in this project), the brackets stayed attached and
    `require_customer`/`require_admin` silently rejected an otherwise perfectly valid token. This
    had been true in production since the JWT authorizer was first wired up — it is not a
    COD-specific, account-specific, or recent regression, and it would have blocked every real
    admin action too, not only customer checkout. `AUTH_TEST_MODE` bypasses this exact code path
    with a hardcoded Python list, which is exactly why "all tests green" never caught it — the
    same lesson discrepancy 6 already drew from the token-type bug, now shown to apply more
    broadly than that one fix closed. Fixed identically across all four services, with 4 new
    regression tests per service exercising `groups()` against the real claim shape, redeployed,
    and confirmed with a live cash-on-delivery order. Two unrelated issues were found and fixed in
    the same pass: a test-isolation bug where the new test files broke an existing
    import-order assumption in each service's real test file (tracked under CP-047), and Docker's
    current default of emitting an attestation-manifest image list that `update-function-code`
    rejects outright. A third finding was **process**, not code: Terraform already had
    digest-pinning written into `lambda_http_services.tf`, but it had never actually been applied
    — the live Lambdas were still on plain `:latest`, meaning a forgotten `update-function-code`
    after a push would have had zero visible signal. `terraform apply` adopted the pin for real.
    Full narrative in `IMPLEMENTATION_RECORD.md`'s 2026-08-17 "systemic RBAC bug" update.
11. **CI (CP-018) went from unstarted to real and verified green on a live GitHub Actions run, and
    caught a genuine bug on its first execution.** `product-service/requirements.txt` and
    `inventory-service/requirements.txt` were encoded as UTF-16 (the other three services' files
    are plain ASCII) — `pip install -r requirements.txt` on the Ubuntu runner cannot parse that,
    and would have failed both services' test jobs on the very first run had it not been caught
    and both files converted to UTF-8 before the push. Separately, the frontend dependency scan
    (`npm audit --audit-level=high`) initially failed on an advisory in `esbuild`/`vite` — both
    `devDependencies`, meaning build-time tooling that never reaches the production `dist/` output
    actually deployed to S3/CloudFront. The audit command was corrected to `--omit=dev`, scoping
    the security gate to what is genuinely shipped to users rather than the tools used to build it
    — verified locally (0 vulnerabilities) before the fix was pushed. Also confirmed: the CI
    environment does not exactly match local development — Python is pinned to 3.11 in CI, while
    the developer's local venvs run 3.13; npm's version is not pinned at all (whatever ships with
    the runner's Node 22 install). Neither has caused an actual failure, and pinning is not
    considered necessary given this codebase's dependencies support both ranges, but it is a real,
    named gap rather than an assumed match.

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
