# Screenshot Capture Guide

Click-by-click companion to `evidence/EVIDENCE_LOG.md`. That file says *what* each
shot must prove; this one says *where to go and what to press* to get it. Work
through it in the order below — later sections depend on state earlier sections
create (fresh orders before you screenshot the orders table, traffic before X-Ray).

## Before you start, every time

- **Region check.** Every AWS Console screenshot needs **eu-west-1 (Ireland)**
  visible in the top-right region selector — except WAF, which lives in
  **Global (CloudFront)** / **US East (N. Virginia)** because that's where
  CloudFront-scoped WAF ACLs are created. Get in the habit of glancing at that
  corner before every capture, not after.
- **Capture tool:** `Win+Shift+S` → rectangle snip. Crop to the panel that
  matters, not the whole browser chrome.
- **Save as you go** directly into `evidence/screenshots/<area>/<NN>-<slug>.png`
  using the filenames already in `EVIDENCE_LOG.md` — don't batch a rename pass
  at the end.
- **Your account ID** is `194680606132`. You'll see it in ARNs and bucket names
  throughout — that's expected, not a leak to worry about hiding.

---

## 1. Local — tests and tooling (items 1–8)

Run from `E:\smartretailx\backend\services\<service>\` in a terminal, using
each service's own venv so you don't need anything installed globally:

```
./venv/Scripts/python.exe -m pytest -v
```

- **#1** `tests/01-pytest-product-service.png` — run it in `product-service/`.
  Capture the full scrollback so individual test names are legible, not just
  the summary line. Current count: **21 passed**.
- **#2** `tests/02-pytest-inventory-service.png` — `inventory-service/`, make
  sure `test_batch_reserve_is_all_or_nothing` is visible in frame. Current
  count: **24 passed**.
- **#3** `tests/03-pytest-payment-service.png` — `payment-service/`. Current
  count: **21 passed**.
- **#4** `tests/04-pytest-order-service.png` — `order-service/`, get the saga
  branch test names in frame (`test_declined_payment_releases_stock_and_fails`,
  `test_unknown_payment_does_not_release_or_refund`, the COD tests). Current
  count: **39 passed**.
  - *(Note: `EVIDENCE_LOG.md`'s target counts — 16/20/14/26 — are stale; the
    real numbers above are higher because of batch-endpoint tests that were
    previously undercounted plus the new `test_auth.py` regression tests
    added 2026-08-17. Capture whatever the live run shows.)*

**#5** `tests/05-k6-oversell-local.png` — needs inventory-service running
locally first:
1. `docker-compose up -d` from the repo root (starts DynamoDB Local).
2. Start inventory-service locally on port 8081 (`uvicorn app.main:app --port 8081`
   from within `inventory-service/`, venv active).
3. Seed a stock record for product id `test-product-1` — e.g.
   `POST http://127.0.0.1:8081/api/v1/inventory/test-product-1/add?quantity=200`
   via `curl` or the Swagger UI at `http://127.0.0.1:8081/docs`.
4. From the repo root: `k6 run tests/k6/oversell_test.js`.
5. Screenshot the summary block — it should show 200 iterations, some 200s
   and some 409s, and critically **available + reserved after the run still
   sums to what you seeded** (check via the inventory GET endpoint) — that's
   the actual oversell-prevention proof, worth a second small crop if it
   doesn't fit in the k6 summary itself.

**#6, #7, #8** — Swagger UI, order-service running locally on port 8083
(`uvicorn app.main:app --port 8083`), browse to `http://localhost:8083/docs`:
- **#6** `api-docs/01-swagger-order-service.png` — expand the `POST /api/v1/orders`
  and `GET /api/v1/orders/{order_id}` sections so the request/response schemas
  are visible.
- **#7** `api-docs/02-swagger-saga-confirmed.png` — click "Try it out" on
  `POST /api/v1/orders`, submit a body with a valid `product_id`/quantity and
  `payment_method: "card"` with a non-declining token, hit Execute, screenshot
  the response panel showing `201` and `"status": "CONFIRMED"`.
- **#8** `api-docs/03-swagger-saga-declined.png` — same, but set
  `payment_token` to something containing `"decline"` (e.g. `tok_test_decline`),
  Execute, capture `"status": "FAILED"`.

---

## 2. Infrastructure as code (items 9–12)

From `E:\smartretailx\terraform\`, PowerShell or Git Bash:

- **#9** `terraform/01-terraform-validate.png` —
  `terraform validate` → capture `Success! The configuration is valid.`
- **#10** `terraform/02-terraform-plan-summary.png` —
  `terraform plan -var-file=dev.tfvars` → scroll to and capture the summary
  line at the bottom (`Plan: X to add, Y to change, 0 to destroy`). If the
  tree is already clean, that's fine — "0 to add, 0 to change, 0 to destroy"
  is itself evidence the deployed state matches the code.
- **#11** `terraform/03-terraform-apply-complete.png` — only capturable during
  a real `terraform apply -var-file=dev.tfvars`. If nothing's pending right
  now, note it and revisit next time you actually change infrastructure —
  don't fabricate one by applying a no-op change just for the screenshot.
- **#12** `terraform/04-deploy-images-script.png` — your image build/push/
  `update-function-code` sequence. Capture a full run for one service showing
  `docker build`, `docker push` with the resulting digest, and the
  `update-function-code` response with matching `CodeSha256`.

---

## 3. Deployed architecture (items 13–25)

All in the **AWS Console**, region **eu-west-1**.

- **#13** `api-gateway/01-routes.png` — API Gateway → **APIs** →
  `smartretailx-dev-api` → **Routes** (left sidebar). Screenshot the full
  route list.
- **#14** `api-gateway/02-stage-and-throttling.png` — same API → **Stages** →
  `$default` → scroll to **Throttling** and confirm **Logging** is enabled;
  capture both settings in one crop (may need two shots stitched, or just
  make sure throttle limits and the access-log toggle are both visible).
- **#15** `lambda/01-function-list.png` — Lambda → **Functions**, type
  `smartretailx` into the filter box. Should show all 9: the four HTTP APIs,
  `outbox-relay`, `order-outbox-relay`, `inventory-consumer`,
  `cognito-post-confirmation`, and (as of tonight) `notification-service`.
- **#16** `lambda/02-order-api-config.png` — click into
  `smartretailx-dev-order-api` → **Configuration** tab → **Environment
  variables**. Confirm table names/service URLs are visible and there is
  **no credential-looking value** anywhere in the list before capturing.
- **#17** `iam/01-order-api-policy-json.png` — Lambda function page →
  **Configuration** → **Permissions** → click the execution role link (opens
  IAM console) → the inline policy → **{} JSON** tab. Capture the statement
  scoped to the orders table + its `/index/*` — and the *absence* of any
  statement naming products/inventory/payments tables is the actual point of
  this shot, so don't crop that part out.
- **#18** `iam/02-inventory-two-roles.png` — two IAM role pages side by side
  (or two crops stitched): the consumer Lambda's role (search IAM → Roles →
  filter `inventory-consumer`) showing `PutItem` only, next to the inventory
  API Lambda's role showing `GetItem`/`PutItem`/`UpdateItem`.
- **#19** `dynamodb/01-tables-list.png` — DynamoDB → **Tables**. All six
  (`smartretailx-dev-products`, `-inventory`, `-payments`, `-orders`,
  `-product-outbox`, `-order-outbox`) with the PITR column visible — you may
  need to add that column via the table's column-settings gear icon if it's
  not shown by default.
- **#20** `dynamodb/02-orders-three-statuses.png` — table `smartretailx-dev-orders`
  → **Explore table items**. Do this *after* the live saga proof batch in
  §5 below so you have fresh CONFIRMED/FAILED/REJECTED rows together, not old
  test data.
- **#21** `dynamodb/03-order-confirmed-item.png` — click into one CONFIRMED
  item from the same table, expand the JSON view. Confirm `unit_price` and
  `payment_id` are populated and there is **no `saga_status` attribute at
  all** — that absence is the whole point of the shot.
- **#22** `dynamodb/04-order-failed-item.png` — same table, a FAILED item,
  `failure_reason` visible naming the decline.
- **#23** `dynamodb/05-order-outbox-published.png` — table
  `smartretailx-dev-order-outbox` → items. `published_at` and `ttl` present,
  **no `status` attribute** (removed on publish).
- **#24** `events/01-event-bus-rules.png` — EventBridge → **Event buses** →
  `smartretailx-dev-events` → **Rules** tab.
- **#25** `events/02-sqs-queue-and-dlq.png` — SQS → search `smartretailx-dev-inventory`
  → open it → scroll to **Dead-letter queue** section showing the redrive
  policy at `maxReceiveCount: 3`, with `smartretailx-dev-inventory-dlq` named.

---

## 4. Network and edge (items 37–44)

Still AWS Console, eu-west-1 (WAF is the one exception — see below).

- **#37** `network/01-vpc-and-subnets.png` — VPC console → **Your VPCs**
  (search or filter by name `smartretailx-dev-vpc`, CIDR `10.0.0.0/16`), then
  a second crop of **Subnets** filtered to the same VPC — 4 subnets, and open
  the **Tags** column or one subnet's detail panel to show `Tier`/`Role`/
  `Services` tags.
- **#38** `network/02-route-tables.png` — VPC → **Route tables**. Open the
  private route table first — confirm **no `0.0.0.0/0` row**, only `local`
  plus the DynamoDB gateway endpoint route — then the public one showing the
  IGW route. Two crops side by side in one image.
- **#39** `network/03-security-groups.png` — VPC → **Security groups** →
  `smartretailx-dev-lambda-sg` → **Inbound rules** tab (should be empty) and
  **Outbound rules** tab (only the two port-443 rules).
- **#40** `network/04-vpc-endpoints.png` — VPC → **Endpoints**. Both
  `vpce-0ab56fe1724f5be0a` (Gateway, DynamoDB) and the interface endpoint for
  `events`, both showing state **Available**.
- **#41** `network/05-flow-logs.png` — VPC → select `smartretailx-dev-vpc` →
  **Flow logs** tab → status **Active**, note the destination CloudWatch log
  group in the same shot.
- **#42** `waf/01-web-acl-rules.png` — **This one is in a different region.**
  WAF & Shield console → make sure the scope selector (top of the WAF
  console, not the usual region dropdown) is set to **Global (CloudFront)**
  → **Web ACLs** → `smartretailx-dev-web-acl` → **Rules** tab showing the
  common rule set, known-bad-inputs, and the per-IP rate rule at 2000 → then
  the **Associated AWS resources** tab to show it's attached to your
  CloudFront distribution.
- **#43** `hosting/01-cloudfront-distribution.png` — CloudFront console →
  your distribution (`E22UOLCAMETWJ`, domain `d1vxg10hlsklfv.cloudfront.net`)
  → **Origins** tab, showing both the S3 origin (via OAC) and the API Gateway
  origin with the `/api/*` behavior.
- **#44** `hosting/02-s3-bucket-private.png` — S3 → `smartretailx-dev-frontend-194680606132`
  → **Permissions** tab, all four "Block public access" toggles **On** in one
  crop, then **Properties** tab showing **Bucket Versioning: Enabled** in a
  second crop.

---

## 5. The saga, proven live (items 26–29, plus a new COD shot)

Do this batch as one sitting, right before capturing items #20 and #28 above,
so everything reflects the same fresh traffic rather than old test rows.

1. Sign in as the **customer** account on the deployed site
   (`https://d1vxg10hlsklfv.cloudfront.net`).
2. Place **four** orders back to back: one that succeeds normally (card,
   valid token) → `CONFIRMED`; one with a token containing `"decline"` →
   `FAILED`; one for a quantity larger than available stock → `REJECTED`; one
   cash-on-delivery → `PENDING_ON_DELIVERY`.
3. **#26** `saga/01-three-orders-terminal-states.png` — a PowerShell table of
   these via the deployed API, e.g.:
   ```powershell
   Invoke-RestMethod "https://d1vxg10hlsklfv.cloudfront.net/api/v1/orders?limit=20" `
     -Headers @{ Authorization = "Bearer $idToken" } |
     Select -ExpandProperty items |
     Select order_id, status, failure_reason, total |
     Format-Table
   ```
   (grab `$idToken` from the browser console the same way you did for the
   session-expiry debugging earlier this session.)
4. **New, not in the original log** — `saga/05-cash-on-delivery-confirmed.png`:
   the COD order from step 2, showing `PENDING_ON_DELIVERY` and no
   `payment_id`.
5. **#27** `saga/02-inventory-after-compensation.png` — after the declined
   order above, `GET /api/v1/inventory/{product_id}` for that product via
   Swagger/curl/PowerShell, showing the reservation was released (available
   count back up, reserved back to what it should be).
6. **#28** `saga/03-stuck-orders-empty.png` — `GET /api/v1/orders/stuck` as an
   **admin** token, showing an empty list — proof every order from this batch
   reached a healthy terminal state, nothing left needing reconciliation.
7. **#29** `saga/04-order-api-state-transitions.png` — CloudWatch → **Log
   groups** → `/aws/lambda/smartretailx-dev-order-api` → the log stream
   covering the timestamps from step 2. Search/filter for `state change` or
   `released` to find the specific lines quickly rather than scrolling.

---

## 6. Observability (items 30–34)

**Capture #30 and #31 immediately after §5's traffic** — the note in
`EVIDENCE_LOG.md` is right that X-Ray's default window is short.

- **#30** `observability/01-xray-service-map.png` — CloudWatch → **X-Ray
  traces** → **Service map**. Should show the gateway, `order-api`,
  `inventory-api`, `payment-api`, and DynamoDB all connected with recent
  traffic. If it looks sparse, re-run one more order from §5 and refresh.
- **#31** `observability/02-xray-trace-waterfall.png` — from the service map
  or **Traces** list, click into one trace from a `POST /orders` call,
  capture the waterfall showing each downstream call's individual duration.
- **#32** `observability/03-log-group-retention.png` — CloudWatch → **Log
  groups**, add the **Retention** column if not shown, filter to
  `smartretailx`, confirm 14 days across them.
- **#33, #34** — marked "pending, item 9" in the log, meaning they depend on
  CP-026 (Terraform observability — alarms/dashboard), which is not built
  yet. Skip these until that checkpoint exists; don't try to fake them
  against console-created-by-hand resources that Terraform doesn't know
  about.

---

## 7. Cost governance (items 35–36)

- **#35** `cost/01-budget-alert.png` — Billing and Cost Management console →
  **Budgets** → your configured budget, showing the alert threshold.
- **#36** `cost/02-cost-explorer.png` — same console → **Cost Explorer** →
  set the date range to cover the project's active period, group by service.
  The point of this shot is showing *actual* spend (supports a
  cost-effectiveness argument), not a suspicious £0 — don't crop out a
  non-zero number out of instinct.

---

## 8. Notification service and today's fixes (items 45–54)

Do the live-order steps (2–4 below) **before** the CloudWatch/DynamoDB shots (5–7), so
they're capturing the same real traffic rather than old data — same rule as §5.

1. **#45** `tests/06-pytest-order-service-with-correlation-id.png` — in
   `order-service/`: `./venv/Scripts/python.exe -m pytest -v`. Scroll so both
   `test_published_event_carries_enough_to_send_a_receipt_with_no_callback`
   and `test_rejected_order_event_also_carries_contact_email_and_items` are
   visible, plus the `59 passed` summary line.
2. **#46** `tests/07-pytest-notification-service.png` — in
   `notification-service/`: same command. `14 passed`.
3. **#47** `terraform/05-plan-six-fixes.png` — from `terraform/`:
   `terraform plan -var-file=dev.tfvars`. If you've already applied, this will
   show `0 to add, 0 to change, 0 to destroy` — that's still valid evidence
   (deployed state matches code); note it as such rather than needing a fresh
   diff.
4. **Place one real order** on the deployed site
   (`https://d1vxg10hlsklfv.cloudfront.net`), signed in as the customer
   account, using `jashok5766+smartretailx@gmail.com` as the contact email so
   the receipt actually lands somewhere you can screenshot. A normal card
   payment (`CONFIRMED`) is the cleanest case.
5. **#48** `lambda/03-notification-service-no-vpc.png` — Lambda →
   `smartretailx-dev-notification-service` → **Configuration** tab → **VPC**
   (left sidebar). Should show no VPC configured at all — worth a second crop
   of `smartretailx-dev-inventory-consumer`'s own VPC tab alongside it for
   contrast (one in, one out, both deliberate).
6. **#49** `iam/03-notification-service-policy-json.png` — same function →
   **Configuration** → **Permissions** → execution role link → inline policy
   → **{} JSON**. Capture the DynamoDB statement showing both `GetItem` and
   `PutItem`, and the SES statement scoped to one identity ARN, not `"*"`.
7. **#50** `sqs/01-notifications-trigger-partial-batch.png` — same function →
   **Configuration** → **Triggers** → click the SQS trigger → confirm
   **"Report batch item failures"** is checked.
8. **#51** `ses/01-identity-verified.png` — SES console → **Identities** →
   `jashok5766+smartretailx@gmail.com` → status column reading **Verified**.
9. **#52** `dynamodb/06-notifications-table-item.png` — DynamoDB →
   `smartretailx-dev-notifications` → **Explore table items** → the
   `event_id` from the order you just placed in step 4.
10. **#53** `observability/06-notification-log-correlation-id.png` —
    CloudWatch → Log groups → `/aws/lambda/smartretailx-dev-notification-service`
    → the log stream covering step 4's timestamp. Find the
    `Sent OrderConfirmed receipt ... correlation_id=...` line. For the
    strongest version of this shot, also pull up
    `/aws/lambda/smartretailx-dev-order-api`'s log for the same order and
    confirm the **same `correlation_id` value** appears in both — that pairing
    is the actual proof the ID traces one request across two services, not
    just that each service logs *something*.
11. **#54** `saga/06-receipt-email-inbox.png` — your Gmail inbox, the receipt
    email from step 4, subject and body both visible in frame.

---

## 9. Bonus — today's RBAC bug hunt (not in the original log, worth adding)

This is genuinely strong "engineering process" evidence for the report: a
real production bug found through live log correlation, root-caused, fixed
across four services, and verified — not discovered by code review.

- `incident/01-cloudwatch-403-then-fixed.png` — CloudWatch → log group
  `/aws/apigateway/smartretailx-dev-api` → filter for `orders`, showing the
  `403`/`401` entries from before the fix. Pair with a second capture of the
  same filter after the fix showing clean `200`s/`201`s.
- `incident/02-terraform-digest-pin-plan.png` — a `terraform plan
  -var-file=dev.tfvars` output showing the four Lambda `image_uri` values
  moving from `:latest` to a pinned `@sha256:...` — this is a real diff you
  can reproduce any time the images drift again, or keep the one already
  captured during today's fix if you saved that terminal output.
- `incident/03-test-auth-regression.png` — one of the four `pytest -v` runs
  showing `test_auth.py`'s four new tests passing (the bracketed-claim
  regression tests) — pick order-service or inventory-service, whichever
  gives the cleanest crop alongside the rest of that service's suite.

---

## 10. WebSocket real-time push (items 55–64)

CP-020's backend was built, tested, and **deployed live 2026-08-18** — all
three Lambdas confirmed `Active`, `order-api`/`inventory-api` confirmed
running their updated images. Frontend wiring (the stock ticker, admin toast,
dashboard) followed the same night. Do the live-traffic steps (4 onward) in
one sitting, same rule as §5 and §8.

1. **#55** `tests/08-pytest-websocket-service.png` — in `websocket-service/`:
   `./venv/Scripts/python.exe -m pytest -v`. `19 passed`, with the
   `test_verify_token_*` names visible.
2. **#56** `tests/09-pytest-order-service-reconciliation.png` — in
   `order-service/`, same command. `68 passed` — scroll so
   `test_compensation_failure_publishes_needs_reconciliation`,
   `test_stock_outcome_unknown_publishes_needs_reconciliation`, and
   `test_payment_outcome_unknown_publishes_needs_reconciliation` are all in
   frame together — that trio is the actual proof all three "needs a human"
   states are covered, not just one.
3. **#57** `terraform/06-plan-websocket-infra.png` — from `terraform/`:
   `terraform plan -var-file=dev.tfvars`. The original infrastructure is
   already applied, but the `EVENT_BUS_NAME` fix (a real gap found on later
   review — it was missing from both `order-api`/`inventory-api`, so
   `StockLevelChanged`/`OrderNeedsReconciliation` were silently never
   publishing) is not yet redeployed as of this note — that plan, showing
   the two environment-variable additions, is itself still-genuine
   before/after evidence. Capture whichever plan is actually pending when
   you get to this step.
4. **#58** `api-gateway/03-websocket-routes.png` — API Gateway console →
   the WebSocket API (`smartretailx-dev-websocket`) → **Routes**. Both
   `$connect` and `$disconnect` visible with their integration target.
5. **#59** `lambda/04-websocket-functions.png` — Lambda → **Functions**,
   filter `websocket`. All three should appear.
6. **Open the deployed frontend, sign in as a customer, and stay on a
   product page** — this is what actually opens a WebSocket connection.
7. **#60** `dynamodb/07-websocket-connections-table.png` — DynamoDB →
   `smartretailx-dev-websocket-connections` → **Explore table items** — your
   own connection row, `role: customer`.
8. **#61** `events/03-order-rules-two-targets.png` — EventBridge → **Rules**
   → `smartretailx-dev-order-confirmed` (or `-order-failed`) → **Targets**
   tab. Should show two: the Notification queue and the WebSocket push
   queue — the point of this shot is that one event now fans out to both.
9. **#62** `events/04-needs-reconciliation-rule.png` — same **Rules** list →
   `smartretailx-dev-order-needs-reconciliation` → its one target.
10. **#63** `saga/07-live-stock-ticker.png` — with the product page still
    open from step 6, open browser DevTools → **Network** tab → filter
    **WS** → click the open connection → **Messages**. In a second
    tab/window, place an order for that same product (or use the admin
    panel's stock-adjust endpoint) to trigger a reservation, then capture
    the `StockUpdated` frame arriving in the first tab's Messages view.
11. **#64** `saga/08-admin-order-toast.png` — sign in as **admin** in
    another tab, stay on the dashboard, then place a real order as a
    customer in yet another tab/window. Capture the toast the instant it
    appears — order ID, outcome, and payment method all legible. For the
    strongest version of this shot, also place one that gets declined
    (`tok_test_decline`) so you have both a success and a failure toast to
    choose from.
