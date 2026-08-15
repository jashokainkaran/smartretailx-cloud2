# SmartRetailX — Implementation Record

This document is a factual record of what has been built, as of the current state of the
repository. It is the primary source for the final report: every claim below is derived from
the code, Terraform configuration, tests, and documentation actually present in the repo, not
from memory or intention. Where a claim could not be verified against a specific file, it is
marked `[UNVERIFIED]`. Architecture Decision Records are referenced by number
(`docs/architecture/ARCHITECTURE_DECISIONS.md`) and summarised, not reproduced.

---

## 1. System Overview

SmartRetailX is a cloud-native, event-driven retail platform built for a university cloud
architecture assignment (COMP60010 / ECDWA2). The design calls for six services: Product
Catalogue, Inventory, Payment, Order, Notification, and User Profile.

**Built and running:**
- **Product Catalogue service** — complete.
- **Inventory service** — complete.
- **Payment service** — complete.
- **Order service and the checkout saga** — complete (§2.5).

**Not started:** Notification, User Profile. No code exists for either beyond a `.gitkeep`
placeholder directory under `backend/services/`.

**Deployed to AWS (eu-west-1):**
- The event backbone (EventBridge bus, SQS queue, DLQ) — Terraform-provisioned.
- The outbox relay Lambda (`smartretailx-dev-outbox-relay`), triggered by a DynamoDB Stream.
- The inventory consumer Lambda (`smartretailx-dev-inventory-consumer`), triggered by SQS.
- The `products` and `inventory` DynamoDB tables, plus the `product-outbox` table.
- Two ECR repositories with lifecycle policies (`product-service`, `outbox-relay`), plus a
  third for `inventory-service`.

**Not deployed to AWS:** the Product, Inventory, and Payment HTTP APIs themselves. They run
locally under `uvicorn` and are not behind API Gateway. No API Gateway resource exists in
Terraform at all.

### End-to-end flow: product creation to stock availability

1. A client sends `POST /api/v1/products` to the Product Catalogue service (running locally on
   port 8080) with a `ProductCreate` body.
2. `repository.create_product()` generates a UUID for the product, builds the `Product` record,
   and builds an outbox record (`event_type: "ProductCreated"`, a JSON-encoded event payload,
   `status: "PENDING"`). Both are written in a single DynamoDB `TransactWriteItems` call against
   the `products` table and the `product-outbox` table — they succeed or fail together.
3. The `product-outbox` table has a DynamoDB Stream (`NEW_IMAGE`). The new outbox item triggers
   the **outbox relay Lambda** via an event source mapping.
4. The relay checks that the record is genuinely new (see §3, self-trigger guard), then calls
   `events:PutEvents` to publish the event to the EventBridge bus `smartretailx-dev-events`,
   using `Source: smartretailx.catalogue` and `DetailType: ProductCreated`.
5. The relay then `REMOVE`s the `status` attribute from the outbox record and sets
   `published_at` and a 7-day `ttl`.
6. An EventBridge rule (`product_created`) matching `source = smartretailx.catalogue` and
   `detail-type = ProductCreated` routes the event to the SQS queue `smartretailx-dev-inventory`.
7. The **inventory consumer Lambda** is triggered by the SQS queue. For each message it parses
   `body.detail.data.product_id` and calls `repository.create_stock_record(product_id)`, which
   does a conditional `put_item` (`attribute_not_exists(product_id)`) against the `inventory`
   table, creating a stock record with `available_quantity: 0`, `reserved_quantity: 0`.
8. From this point, the Inventory service (running locally on port 8081) can `add_stock`,
   `reserve_stock`, `release_stock`, and `confirm_stock` against that record.
9. The Order service (running locally on port 8083) orchestrates a purchase across the other
   three: it prices the basket from the Product Catalogue, reserves stock all-or-nothing,
   charges the Payment service, confirms the reservation, and writes `CONFIRMED` together with
   an `OrderConfirmed` outbox record in one transaction. Every failure path compensates or
   escalates explicitly (§2.5).

A complete checkout flow now exists end to end, locally. The deployed slice on AWS proves that
a product creation event reliably reaches Inventory; the saga itself has been proven by its
test suite and has not yet been exercised against deployed services behind API Gateway.

---

## 2. Services

### 2.1 Product Catalogue Service

**Location:** `backend/services/product-service/`. **Port (local):** 8080.

**Purpose and scope:** owns product records, exposes CRUD-minus-delete over them, and is the
publisher side of the `ProductCreated` event.

**Endpoints** (`app/main.py`):

| Method | Path | Request | Success | Failure |
|---|---|---|---|---|
| GET | `/health` | — | 200 `{"status": "ok"}` | — |
| POST | `/api/v1/products` | `ProductCreate` | 201 `Product` | Uncaught exception → 500 if the `TransactWriteItems` call fails for any reason (not explicitly handled) |
| GET | `/api/v1/products/{product_id}` | — | 200 `Product` | 404 `{"detail": "Product not found"}` if `repository.get_product` returns `None` |
| PUT | `/api/v1/products/{product_id}` | `ProductUpdate` | 200 `Product` | 404 if `repository.update_product` returns `None` (product doesn't exist) |
| PATCH | `/api/v1/products/{product_id}/deactivate` | — | 200 `Product` (`active: false`) | 404 if missing |
| PATCH | `/api/v1/products/{product_id}/activate` | — | 200 `Product` (`active: true`) | 404 if missing |
| GET | `/api/v1/products` | query: `limit` (1–100, default 20), `cursor`, `include_inactive` (default `false`) | 200 `ProductPage` | 422 if `limit` outside 1–100 (FastAPI/Pydantic validation) |

**Data model** (`app/models.py`):
- `ProductBase`: `name: str`, `description: str`, `price: Decimal` (`gt=0`, `decimal_places=2`),
  `category: str`, `image_url: Optional[str] = None`.
- `ProductCreate(ProductBase)`: no additional fields — the client never supplies an id.
- `ProductUpdate(BaseModel)`: the same five fields, all `Optional`, all defaulting to `None` —
  a partial-update shape (ADR-038).
- `Product(ProductBase)`: adds `id: str`, `active: bool = True`. `active` is not settable by the
  client on creation — it only appears on the stored/returned shape.
- `ProductPage(BaseModel)`: `items: list[Product]`, `next_cursor: Optional[str] = None`.

**DynamoDB tables:**
- `products` (`config.PRODUCTS_TABLE`, `smartretailx-dev-products` in AWS). Key schema: hash
  key `id` (String).
- `product-outbox` (`config.OUTBOX_TABLE`). Key schema: hash key `event_id` (String). Detailed
  in §3.

**Notable implementation techniques:**
- **Transactional outbox** (ADR-020): `create_product()` writes the product and its outbox
  record in one `TransactWriteItems` call via the low-level `dynamodb_client` (the resource-level
  `boto3.resource` API does not expose transactions), converting `Item` dicts to DynamoDB wire
  format with `boto3.dynamodb.types.TypeSerializer`.
- **Partial update via selective `UpdateExpression`** (ADR-038): `update_product()` builds the
  `UpdateExpression` only from fields that are not `None` in the `ProductUpdate` body. If every
  field is `None`, it short-circuits to `get_product()` rather than issuing an empty
  `UpdateExpression`, which DynamoDB rejects. Every attribute name is routed through an
  `ExpressionAttributeNames` placeholder (`#name`, `#price`, …) rather than only the ones known
  to be reserved words (`name` is one), on the reasoning that this is simpler than tracking
  which of the rest are safe.
- **Soft deletion** (ADR-037): there is no delete endpoint. `set_product_active()` flips a
  boolean `active` flag via `update_item`, guarded by `ConditionExpression="attribute_exists(id)"`
  so acting on a non-existent product returns `None` (→ 404) rather than creating one.
- **Backward-compatible listing filter:** `list_products(include_inactive=False)` applies
  `FilterExpression="attribute_not_exists(#active) OR #active = :true"`. Products created before
  the `active` field existed have no such attribute at all; the filter treats a missing
  attribute as active so the pre-existing catalogue is not silently hidden.
- **Environment-driven credential resolution** (ADR-025): a single `_dynamodb_kwargs` dict feeds
  both the `boto3.resource` and the low-level `boto3.client`, so they cannot diverge. `region_name`
  is always set; `endpoint_url` and dummy `"local"`/`"local"` credentials are added only when
  `config.DYNAMODB_ENDPOINT` is set (local dev against DynamoDB Local). `DYNAMODB_ENDPOINT` has
  no default (`os.environ.get("DYNAMODB_ENDPOINT")` → `None`), so a deployment that forgets to
  configure it reaches real AWS and resolves the Lambda execution role's temporary credentials,
  rather than silently trying to reach a `localhost` that doesn't exist inside a Lambda
  container.
- **Currency as JSON strings, never floats** (ADR-039): `price` is `Decimal` end to end; the API
  contract expects amounts as JSON strings (`"19.99"`), not JSON numbers, because a JSON number
  is parsed to a Python `float` before Pydantic can construct the `Decimal`, discarding trailing
  zeros and reintroducing binary floating-point imprecision. All tests send prices this way.
- **Lambda packaging** (ADR-005, ADR-024): the Dockerfile is built on
  `public.ecr.aws/lambda/python:3.11`; `main.py` ends with `handler = Mangum(app)`. Locally the
  identical code runs under `uvicorn`; only DynamoDB Local runs in `docker-compose.yml`.
- **Cursor pagination via `LastEvaluatedKey`, not an offset:** `list_products()` passes a
  `Limit` to `table.scan()` and, if the client supplied a `cursor`, decodes it back into
  DynamoDB's `ExclusiveStartKey` format; the response's `LastEvaluatedKey` (if present) is
  base64-encoded into the `next_cursor` returned to the client. There is no offset-based
  alternative implemented, and DynamoDB has no native concept of an offset to implement one
  against — a `SKIP n` style query would require scanning and discarding `n` items on every
  request, with cost proportional to how deep into the result set the client has paged, rather
  than the constant-cost key lookup `LastEvaluatedKey` provides.

**Test coverage** (`tests/test_products.py`, 10 tests, run against a throwaway `ProductsTest` +
`ProductOutboxTest` table pair created and torn down per test):

| Test | Proves |
|---|---|
| `test_health` | Health endpoint returns 200 and the expected body. |
| `test_create_product` | Creation returns 201, echoes the submitted name, serialises `price` as the string `"19.99"`, and generates a non-empty `id`. |
| `test_get_product` | A created product can be fetched by id. |
| `test_get_missing_product_returns_404` | Fetching an unknown id returns 404. |
| `test_update_product_changes_only_supplied_fields` | `PUT` with only `price` in the body leaves `name`, `description`, `category` unchanged. |
| `test_update_missing_product_returns_404` | `PUT` against a non-existent id returns 404. |
| `test_deactivate_then_list_excludes_by_default` | After `PATCH .../deactivate`, the product is absent from the default `GET /api/v1/products` listing. |
| `test_deactivate_then_list_include_inactive_shows_it` | The same deactivated product appears when `include_inactive=true`. |
| `test_activate_restores_default_listing` | `PATCH .../activate` after deactivation restores the product to the default listing. |
| `test_list_products_pagination` | Creating 3 products and listing with `limit=2` returns 2 items plus a `next_cursor`; following the cursor returns the remaining 1 item and no further cursor. |

**Not tested:** the `TransactWriteItems` call failing partway (no test simulates a transaction
failure to confirm neither write lands); the outbox record's exact stored shape.

---

### 2.2 Inventory Service

**Location:** `backend/services/inventory-service/`. **Port (local):** 8081.

**Purpose and scope:** tracks per-product stock in two buckets, exposes reserve/release/confirm
operations with oversell prevention, and — via a separate Lambda entry point — consumes
`ProductCreated` events to auto-create empty stock records.

**Endpoints** (`app/main.py`; none declare a Pydantic `response_model`, so successful reserve/
release/confirm/add responses are the raw `Attributes` dict returned by DynamoDB, not a
validated `InventoryItem`):

| Method | Path | Request | Success | Failure |
|---|---|---|---|---|
| GET | `/health` | — | 200 `{"status": "ok"}` | — |
| GET | `/api/v1/inventory/{product_id}` | — | 200 `InventoryItem` | 404 `{"detail": "No inventory record for this product"}` |
| POST | `/api/v1/inventory/{product_id}/reserve?quantity=N` | — | 200, updated attributes | 400 if `quantity <= 0`; 409 if `available_quantity < quantity` |
| POST | `/api/v1/inventory/{product_id}/release?quantity=N` | — | 200, updated attributes | 400 if `quantity <= 0`; 409 if `reserved_quantity < quantity` |
| POST | `/api/v1/inventory/{product_id}/confirm?quantity=N` | — | 200, updated attributes | 400 if `quantity <= 0`; 409 if `reserved_quantity < quantity` |
| POST | `/api/v1/inventory/{product_id}/add?quantity=N` | — | 200, updated attributes | 400 if `quantity <= 0` |

**Data model** (`app/models.py`): `InventoryItem(BaseModel)`: `product_id: str`,
`available_quantity: int`, `reserved_quantity: int = 0`.

**DynamoDB table:** `inventory` (`config.INVENTORY_TABLE`, `smartretailx-dev-inventory` in AWS).
Key schema: hash key `product_id` (String). `point_in_time_recovery` enabled in Terraform.

**Notable implementation techniques:**
- **Two-bucket reservation model with conditional writes** (ADR-017): stock is
  `available_quantity` + `reserved_quantity`. `reserve_stock` does a single `update_item` with
  `ConditionExpression="available_quantity >= :qty"` and an expression that atomically moves
  units from available to reserved — the condition lives inside the same atomic write as the
  change, eliminating a read-then-write race. `release_stock` and `confirm_stock` apply the
  analogous conditions in the opposite/terminal direction. `add_stock` uses
  `if_not_exists(available_quantity, :zero)` in its `UpdateExpression` so a first-ever stock
  entry is created atomically rather than requiring a separate existence check.
- **`ClientError` → domain error translation:** all four mutating functions catch
  `ConditionalCheckFailedException` specifically and re-raise as `ValueError` with a
  human-readable message; `main.py` catches `ValueError` and maps it to HTTP 409. Any other
  `ClientError` is re-raised unhandled.
- **Idempotent event-driven record creation** (ADR-022): `create_stock_record(product_id)` uses
  `put_item` with `ConditionExpression="attribute_not_exists(product_id)"`, catching
  `ConditionalCheckFailedException` and returning `False` rather than raising — a duplicate
  delivery of the same event is treated as an expected, successful outcome, not an error. This
  matters because SQS is at-least-once, not exactly-once.
- **Same connection pattern as Product** (ADR-025), simplified: only a `boto3.resource` is
  needed (no cross-table transaction), so there's no low-level client here.

**SQS consumer** (`app/consumer.py`, Lambda entry point `app.consumer.handler`, distinct from
the HTTP API's `app.main.handler` — the same container image is deployed twice with the command
overridden, per ADR-024): for each SQS record, parses `json.loads(record["body"])`, reads
`body["detail"]["data"]["product_id"]` (the SQS message body is the full EventBridge-delivered
event), calls `repository.create_stock_record(product_id)`, and logs at INFO whether the record
was newly `created` or was a `duplicate`. Returns `{"created": N, "duplicates": N}`.

**Test coverage** (`tests/test_inventory.py`, 8 tests, against a throwaway `InventoryTest` table
seeded with one record — `product_id: "p1"`, 100 available, 0 reserved — before each test):

| Test | Proves |
|---|---|
| `test_health` | Health endpoint works. |
| `test_get_stock` | Seeded stock is readable via the API. |
| `test_get_stock_missing_returns_404` | An unknown `product_id` returns 404. |
| `test_reserve_reduces_available_and_raises_reserved` | Reserving 30 of 100 leaves 70 available, 30 reserved. |
| `test_reserve_more_than_available_is_rejected` | Reserving 1000 of 100 returns 409 and leaves stock **completely unchanged** — the core oversell-prevention assertion. |
| `test_release_returns_stock_to_available` | Reserve 30 then release 30 restores 100 available, 0 reserved. |
| `test_confirm_removes_reserved_without_changing_available` | Reserve 30 then confirm 30 leaves 70 available (unchanged from reserve) and 0 reserved. |
| `test_reserve_zero_or_negative_is_rejected` | `quantity=0` and `quantity=-5` both return 400. |

**Not tested:** `add_stock`; `create_stock_record` (and therefore `consumer.py` end to end) has
no test anywhere in the repository — the SQS consumer's only verification is the manual,
console-observed end-to-end flow described in §1 and `docs/PROJECT_BRIEF.md`.

---

### 2.3 Payment Service

**Location:** `backend/services/payment-service/`. **Port (local):** 8082.

**Purpose and scope:** charges and refunds payments through a swappable provider, with the mock
provider standing in for a real PSP. Structurally enforces the PCI scope reduction in ADR-007.

**Endpoints** (`app/main.py`):

| Method | Path | Request | Success | Failure |
|---|---|---|---|---|
| GET | `/health` | — | 200 `{"status": "ok"}` | — |
| POST | `/api/v1/payments` | `PaymentRequest` | 201 `Payment` if `status == "SUCCEEDED"`; 402 `Payment` if `status == "FAILED"` | 500, uncaught, if the provider raises (see below) |
| GET | `/api/v1/payments/{payment_id}` | — | 200 `Payment` | 404 if missing |
| POST | `/api/v1/payments/{payment_id}/refund` | — | 200 `Payment` (fresh refund or already-refunded) | 404 if missing; 409 if status is `FAILED`, `UNKNOWN`, or `PENDING` |

The 201/402 split is implemented by injecting FastAPI's `Response` object and setting
`response.status_code` at runtime, rather than raising `HTTPException` for the decline case —
`HTTPException` would wrap the body in `{"detail": ...}`, but the requirement is that the caller
sees the full `Payment` record (including `failure_reason`) on both outcomes.

If `get_provider().charge(...)` raises any exception, `repository.charge()` re-raises after
recording the outcome as `UNKNOWN` (see below); `main.py` has no `try/except` around this call,
so the exception propagates to FastAPI's default handler and the endpoint returns an unhandled
500. This is a deliberate consequence of the design, not an oversight: the failure is recorded
in DynamoDB before the exception is allowed to propagate.

**Data model** (`app/models.py`):
- `PaymentRequest`: `order_id: str`, `amount: Decimal` (`gt=0`, `decimal_places=2`),
  `payment_token: str` — annotated in code as "PSP token — never a card number (ADR-007)".
- `Payment`: `payment_id: str`, `order_id: str`, `amount: Decimal`,
  `status: str` (`PENDING | SUCCEEDED | FAILED | REFUNDED | UNKNOWN`),
  `transaction_reference: Optional[str] = None`, `failure_reason: Optional[str] = None`,
  `created_at: str`, `refunded_at: Optional[str] = None`,
  `already_refunded: Optional[bool] = None`.

**DynamoDB table:** `config.PAYMENTS_TABLE` (default `"Payments"`, test table `PaymentsTest`).
Key schema: hash key `payment_id` (String). **Not present in Terraform** — no AWS table exists
for this service (see §8).

**Notable implementation techniques:**
- **Provider abstraction** (ADR-036): `app/providers/base.py` defines `PaymentProvider(ABC)`
  with abstract `charge(amount, payment_token, idempotency_key) -> ChargeResult` and
  `refund(transaction_reference, idempotency_key) -> bool`. `ChargeResult` carries `succeeded`,
  `transaction_reference`, `failure_reason`. `app/providers/__init__.py`'s `get_provider()`
  reads `config.PAYMENT_PROVIDER` (default `"mock"`); it returns `MockPaymentProvider()` for
  `"mock"` and **raises `ValueError`** for anything else — there is no silent fallback.
- **Deterministic mock decline:** `MockPaymentProvider.charge()` declines
  (`ChargeResult(False, None, "Card declined by issuer")`) when the string `"decline"` appears
  in `payment_token` (e.g. `tok_test_decline`); otherwise it succeeds
  (`ChargeResult(True, "txn_" + uuid4().hex)`). This replaced an earlier amount-based rule
  (decline when the amount's cents equalled 99) that was rejected because `.99` is the most
  common retail price ending and would have declined most realistic prices. `refund()` always
  returns `True`. Both methods accept `idempotency_key` but ignore it — the mock is stateless; a
  real PSP would use it to deduplicate retried requests, and the parameter exists so a real
  implementation needs no interface change.
- **Write-intent-before-action** (ADR-034): `charge()` generates `payment_id`, writes a
  `PENDING` record via `put_item` **before** calling the provider, then transitions the same
  record to `SUCCEEDED` (with `transaction_reference`) or `FAILED` (with `failure_reason`) via
  `update_item`. If the provider call itself raises, the record is transitioned to `UNKNOWN`
  with `failure_reason` set to `str(exc)`, and the exception is re-raised. This was a direct
  code-review fix (§7): the original implementation called the provider first and wrote nothing
  until it returned, so an exception from the provider left no record that a charge attempt —
  possibly a successful one — had ever happened.
- **Idempotent refund guarded on two levels:** a pre-check rejects `FAILED`, `UNKNOWN`, and
  `PENDING` payments with a `ValueError` before the provider is ever called (avoiding calling
  `provider.refund()` with a `None` transaction reference — see §7), and short-circuits an
  already-`REFUNDED` payment by returning it with `already_refunded=True` without calling the
  provider again. The actual safety property, though, is the `update_item`'s
  `ConditionExpression="attribute_exists(payment_id) AND #status = :succeeded"`, which permits
  only a `SUCCEEDED → REFUNDED` transition — a concurrent or retried refund cannot double-apply
  regardless of what the pre-check observed. On `ConditionalCheckFailedException` the code
  re-reads the record and branches: `REFUNDED` → idempotent success; not found → `None`; anything
  else → `ValueError`. The `record is None` branch is unreachable in the current codebase (no
  delete operation exists), and the final `ValueError`'s message is worded for "failed" though
  the branch is realistically only reached via the `REFUNDED` race — left as-is, flagged in §8.
  The pre-check itself is structured as a **deny-list** — it names the statuses that must be
  rejected (`FAILED`, `UNKNOWN`, `PENDING`) rather than the one status that is allowed to
  proceed (`SUCCEEDED`). This is a known, deliberately-accepted weakness, not an oversight: a
  deny-list fails *open* — a status value introduced later is silently permitted through unless
  someone remembers to add a rejection for it, which is exactly what happened when `PENDING` was
  introduced (§7, problem 8) before being added here. An allow-list (proceed only if `status ==
  "SUCCEEDED"`) fails *closed* and would not have had this gap, at the cost of a single generic
  rejection message instead of one tailored per rejected status. The deny-list was kept for the
  clearer per-status messages; the trade-off is recorded here rather than silently accepted.
- **`already_refunded` is never persisted:** it describes the outcome of a single refund call,
  not a property of the payment. The initial `put_item` in `charge()` explicitly excludes it
  (`pending.model_dump(exclude={"already_refunded"})`); no `update_item` call in the file ever
  writes it. It is set only on the in-memory `Payment` object returned to the caller, via
  `.model_copy(update={"already_refunded": ...})`.
- **Logging:** a module-level `logger = logging.getLogger(__name__)` logs at INFO for: charge
  succeeded (`payment_id`, `order_id`, `status`), charge declined (`payment_id`, `order_id`,
  `failure_reason`), charge outcome unknown (`payment_id`, `order_id`, the exception), refund
  performed (`payment_id`), and refund already performed (`payment_id`). `payment_token` and
  `amount` are never logged anywhere in the file.

**Test coverage** (`tests/test_payments.py`, 14 tests, against a throwaway `PaymentsTest`
table):

| Test | Proves |
|---|---|
| `test_health` | Health endpoint works. |
| `test_charge_succeeds` | A normal charge returns 201, `status: SUCCEEDED`, a non-null `transaction_reference`. |
| `test_charge_declined` | `payment_token: "tok_test_decline"` returns 402, `status: FAILED`, null `transaction_reference`, non-empty `failure_reason`. |
| `test_get_payment` | A charged payment can be fetched by id. |
| `test_get_missing_payment_returns_404` | Unknown id returns 404. |
| `test_refund_succeeded_payment` | Refunding a `SUCCEEDED` payment returns 200, `status: REFUNDED`. |
| `test_refund_already_refunded` | Refunding twice returns 200 both times, with an identical `refunded_at`, `already_refunded` False then True. |
| `test_already_refunded_is_not_persisted` | After a refund, `GET`ting the payment shows `already_refunded: None` — it was never stored. |
| `test_charge_provider_exception_returns_500_and_records_unknown` | Monkeypatches the provider to raise; asserts the endpoint returns 500 and a scan of the table finds the record with `status: UNKNOWN` and the exception text in `failure_reason`. |
| `test_refund_unknown_payment_returns_409` | Refunding a payment left `UNKNOWN` by the previous scenario returns 409. |
| `test_charge_does_not_persist_already_refunded` | A raw `boto3.get_item` (not the API) on a freshly charged payment shows no `already_refunded` key in the item at all. |
| `test_refund_pending_payment_returns_409` | A record inserted directly as `PENDING` (via raw `put_item`, bypassing the API's brief PENDING window) returns 409 on refund. |
| `test_refund_failed_payment_returns_409` | Refunding a declined (`FAILED`) payment returns 409. |
| `test_refund_missing_payment_returns_404` | Refunding an unknown id returns 404. |

**Not tested:** the `ConditionalCheckFailedException` race branch of `refund()` itself (no test
forces two genuinely concurrent refunds); the `get_provider()` factory's `ValueError` path for
an unrecognised `PAYMENT_PROVIDER` value.

---

### 2.4 Outbox Relay (Lambda)

**Location:** `backend/services/outbox-relay/`. Not an HTTP service — a single Lambda entry
point, `app.handler.handler`, triggered by a DynamoDB Stream. Deployed to AWS.

**Behaviour** (`app/handler.py`): `EVENT_BUS_NAME` and `OUTBOX_TABLE` are read with
`os.environ["..."]` (not `.get()`) — a missing value crashes the function on cold start rather
than silently degrading. `EVENT_SOURCE = "smartretailx.catalogue"` is a module constant, not
configuration. For each stream record: skip if `eventName` is not `INSERT` or `MODIFY`; skip if
there is no `NewImage`; deserialize the image with `boto3.dynamodb.types.TypeDeserializer`; skip
if `"status" not in item` (the self-trigger guard — see §3); otherwise call `events:PutEvents`
with the stored `event_type` as `DetailType` and the stored `payload` (already a JSON string) as
`Detail`, then `update_item` to `REMOVE status` and `SET published_at, ttl` (`ttl` = now + 7
days). Logs a per-batch summary of `published`/`skipped` counts at INFO.

**Test coverage:** none. `backend/services/outbox-relay/` has no `tests/` directory.

---

### 2.5 Order Service and the Checkout Saga

**Location:** `backend/services/order-service/`. **Port (local):** 8083.

**Purpose and scope:** owns order records and orchestrates the checkout saga (ADR-028) —
reserve stock, take payment, confirm the reservation — invoking compensating actions itself
when a step fails. It is the only service in the system that coordinates other services.

**Endpoints** (`app/main.py`):

| Method | Path | Request | Success | Failure |
|---|---|---|---|---|
| GET | `/health` | — | 200 `{"status": "ok"}` | — |
| POST | `/api/v1/orders` | `OrderCreate` | 201 `Order` in a terminal state | 409 if the basket cannot be priced; 503 if the catalogue is unreachable; 422 on an empty basket or non-positive quantity |
| GET | `/api/v1/orders/stuck` | — | 200 `list[Order]` needing reconciliation | — |
| GET | `/api/v1/orders/{order_id}` | — | 200 `Order` | 404 if missing |
| GET | `/api/v1/orders` | query: `customer_id` (required), `limit` (1–100, default 20), `cursor` | 200 `OrderPage` | 400 on a malformed cursor |

`POST /api/v1/orders` returns **201 regardless of the saga's outcome**, including `REJECTED`,
`PAYMENT_UNKNOWN`, `STOCK_UNKNOWN` and `COMPENSATION_FAILED`. The order record was created, is
addressable, and its `status` field carries the result. A 4xx would assert that the request was
malformed, which it was not — the stock simply ran out. The only two failures that produce no
order at all are those where nothing happened anywhere: an unpriceable basket and an unreachable
catalogue.

`/api/v1/orders/stuck` is declared **before** `/api/v1/orders/{order_id}` in the source file.
FastAPI matches routes in declaration order, so the parameterised route would otherwise capture
`"stuck"` as an order id and return 404.

**Data model** (`app/models.py`):
- `OrderItemRequest`: `product_id: str`, `quantity: int` (`gt=0`). Carries **no price**.
- `OrderCreate`: `customer_id: str`, `items: list[OrderItemRequest]` (`min_length=1`,
  `max_length=100`), `payment_token: str`.
- `OrderLineItem`: `product_id`, `quantity`, `unit_price: Decimal`, `name` — the stored form,
  with the price resolved server-side.
- `Order`: `order_id`, `customer_id`, `items: list[OrderLineItem]`, `total: Decimal`,
  `status: str`, `payment_id: Optional[str]`, `failure_reason: Optional[str]`, `created_at`,
  `updated_at`.
- `OrderPage`: `items: list[Order]`, `next_cursor: Optional[str]`.

**DynamoDB tables:**
- `orders` (`config.ORDERS_TABLE`, `smartretailx-dev-orders` in AWS). Hash key `order_id` (S).
  Two GSIs: `customer-orders-index` (hash `customer_id`, range `created_at`) and
  `saga-status-index` (hash `saga_status`, range `created_at`). `point_in_time_recovery`
  enabled.
- `order-outbox` (`config.ORDER_OUTBOX_TABLE`). Hash key `event_id` (S), Streams `NEW_IMAGE`,
  sparse `pending-index`, 7-day TTL — the same shape as `product-outbox`.

#### The states

Nine in total, in `app/states.py`.

In flight: `PENDING` → `RESERVING_STOCK` → `TAKING_PAYMENT` → `CONFIRMING_STOCK`.
Terminal: `CONFIRMED`, `REJECTED`, `FAILED`, `PAYMENT_UNKNOWN`, `STOCK_UNKNOWN`,
`COMPENSATION_FAILED`.

ADR-033 requires each state to be written **before** the call it describes. The states were
therefore renamed from the ADR's original `STOCK_RESERVED` / `PAYMENT_TAKEN` to the progressive
forms above: a record saying `STOCK_RESERVED`, written before the reserve has happened, asserts
as fact something that might never occur, whereas `RESERVING_STOCK` asserts only what the saga
was attempting. The semantics are unchanged — intent before action — but the record no longer
states a falsehood, and recovery reads correctly: the state says what was being attempted, the
participant says whether it happened.

Two of the terminal states are amendments to ADR-033, which originally listed four. Both were
added because an outcome existed that the four could not represent (see §7).

#### The distinction the whole saga turns on

`app/clients.py` classifies every downstream outcome into exactly two failure kinds, and every
branch of the saga depends on which one it gets:

- **`DownstreamRejected`** — the service answered, and the answer was no. A 4xx. The request
  reached the service, was understood, and was refused; all downstream 4xx responses in this
  system come from conditional writes that either applied or did not. The outcome is known.
- **`DownstreamUnknown`** — no usable answer at all. A timeout, a dropped connection, or a 5xx.
  The operation may have completed perfectly and lost the reply, or never have happened.

The mapping is: 2xx → success; 4xx → `DownstreamRejected`; 5xx, timeout and connection error →
`DownstreamUnknown`.

Collapsing these two into a single "it failed" is the most dangerous simplification available in
a saga, because **the correct response to each is the opposite of the other**. A refusal should
be compensated. A non-answer must not be, because compensating something that never happened
causes precisely the damage the compensation exists to prevent: refunding a customer who was
never charged, or releasing stock that was never reserved.

#### Why stock is reserved before the card is charged

The step order is itself a decision. Reserving first means the failure that can occur before any
money moves is the stock failure, whose compensation costs nobody anything. Charging first would
mean that a subsequent reservation failure has already taken the customer's money and owes a
refund — converting a bookkeeping problem into a financial one. Where the ordering of two
fallible steps is free to choose, the step allowed to fail first should be the one that is not
about money.

#### The flow, with every branch

1. **Price the basket.** `clients.fetch_products()` resolves every line against the Product
   Catalogue in one `BatchGetItem`-backed call. The client never sends a price — `OrderCreate`
   has nowhere to put one — so a tampered request cannot alter the total. Prices are
   **snapshotted** onto `OrderLineItem`: an order is a historical record of an agreement, not a
   live view of the catalogue, and must keep showing what the customer agreed to after the
   catalogue price changes. An unknown or deactivated product raises `BasketInvalid` → 409, and
   **no order record is created**, because pricing is a pure read with no side effects; unlike a
   stock failure there is nothing to audit. Deactivated products are returned by the batch
   endpoint rather than filtered out (ADR-037) precisely so this check can distinguish a
   withdrawn product from a non-existent one and tell the customer which.
2. **Write the order `PENDING`**, via a conditional `put_item` on `attribute_not_exists(order_id)`
   so a retried POST cannot overwrite an in-flight order and restart its saga.
3. **Write `RESERVING_STOCK`, then call `POST /api/v1/inventory/reserve`.**
   - `DownstreamRejected` (409) → `REJECTED`. Nothing to compensate: the reserve is a single
     `TransactWriteItems`, so a failure leaves every product in the basket untouched.
   - `DownstreamUnknown` → `STOCK_UNKNOWN`. No release is attempted.
4. **Write `TAKING_PAYMENT`, then call `POST /api/v1/payments`.**
   - `DownstreamRejected` (402, declined) → release the stock, then `FAILED`. Safe because a 402
     is a definite answer. If the release itself fails → `COMPENSATION_FAILED`.
   - `DownstreamUnknown` → `PAYMENT_UNKNOWN`. Stock is **not** released and no refund is
     attempted (ADR-034).
5. **Write `CONFIRMING_STOCK`, then call `POST /api/v1/inventory/confirm`.**
   - `DownstreamRejected` → refund, then `FAILED`. The Payment service's refund is idempotent,
     so a retry cannot double-refund. If the refund fails → `COMPENSATION_FAILED`.
   - `DownstreamUnknown` → `STOCK_UNKNOWN`, retaining `payment_id`.
6. **`CONFIRMED`**, written together with an `OrderConfirmed` outbox record in one transaction.

**Compensation is attempted once.** There is no retry loop before `COMPENSATION_FAILED`.
ADR-035 rejected silent retry-then-log because it buries a financial discrepancy in a log line;
a bounded compensation retry queue is the correct production design and was deferred on time,
with this state as the fallback it would still require.

#### Why `PAYMENT_UNKNOWN` and `STOCK_UNKNOWN` exist

`PAYMENT_UNKNOWN` implements ADR-034 at the saga layer. When the payment call gives no usable
answer, the card may or may not have been charged. Releasing the stock would take goods back
from a customer who may have paid; refunding would return money that may never have moved — and
the Payment service rejects a refund of an `UNKNOWN` payment with 409 for exactly that reason.
Both available actions are errors, so the saga takes neither and records the uncertainty
instead. No event is published: nothing downstream should act on an outcome that is genuinely
undetermined.

`STOCK_UNKNOWN` is the same principle applied to the inventory calls, and it exists **only
because ADR-040 was deferred**. Without reservation identity, a timed-out reserve cannot be
resolved after the fact: reading `available_quantity` is uninformative, because it moves for
other customers' reasons, and nothing anywhere records which order holds which units. The three
alternatives were each rejected for asserting something unverified — treating it as `REJECTED`
leaks stock permanently and silently if the reserve did land; issuing a release invents stock
that never existed if it did not, reintroducing the oversell ADR-017 prevents; leaving the order
in flight makes a dead saga indistinguishable from a running one. With reservation identity the
saga would simply query the reservation and know, and this state would not exist. It is a
visible, traceable consequence of a deliberate trade-off rather than an accident.

The two differ in what is at stake: reached from `RESERVING_STOCK`, no money has moved; reached
from `CONFIRMING_STOCK`, the customer has already paid, and `payment_id` is retained so a human
reconciling the order can see that.

#### The conditional state transition

`repository.set_status()` guards every transition with
`ConditionExpression="#status = :expected"`. This is what makes the saga safe against a
duplicate or concurrent run: two invocations for the same order cannot both advance it, because
the second one's condition fails against a state that has already moved on. It is the same
primitive as `available_quantity >= :qty` in Inventory — the correctness condition lives inside
the atomic write rather than in a read-then-write that something might interleave. `status` is a
DynamoDB reserved word and is routed through an `ExpressionAttributeNames` placeholder, as is
every other name, for the reason given in ADR-038.

#### The sparse recovery index

`saga_status` is a second attribute holding the same value as `status`, existing only to drive
`saga-status-index`. It is `REMOVE`d when an order reaches `CONFIRMED`, `REJECTED` or `FAILED` —
at which point the item no longer has a value for the index's hash key and drops out of the
index entirely — and deliberately **retained** for `PAYMENT_UNKNOWN`, `STOCK_UNKNOWN` and
`COMPENSATION_FAILED`. The index therefore contains exactly two categories: orders still in
flight, and orders a human must resolve. In a healthy system it is near-empty, and anything
lingering in it is by construction a problem. This is the same technique as the outbox's
`pending-index` (§3).

`list_orders_needing_attention()` issues **one query per status**, because a GSI hash key can
only be queried for equality — there is no query for "any value of `saga_status`". That
constraint is why `NEEDS_ATTENTION` is a small, closed set.

#### Terminal states and the outbox

`repository.set_status_and_publish()` writes the terminal state and an outbox record in a single
`TransactWriteItems` across the `orders` and `order-outbox` tables. Writing `CONFIRMED` and then
failing to publish `OrderConfirmed` would leave a paid, confirmed order that no consumer ever
hears about, with nothing recording that a publish was owed — the dual-write failure ADR-020
exists to prevent. The publish cannot be made atomic with the state change, but the decision to
publish can, because both are DynamoDB writes.

`OrderConfirmed` is published on `CONFIRMED`; `OrderFailed` on `REJECTED` and on `FAILED`. The
three reconciliation states publish **nothing**, on the grounds that an unresolved discrepancy
is not a clean business outcome to broadcast.

The outbox record carries an `event_source` field (`smartretailx.orders`). The relay Lambda was
changed to read the source from the record, falling back to its previous hardcoded
`smartretailx.catalogue` for records written before the field existed. This keeps ADR-021's
position intact — the source string is part of the contract and belongs to the publisher, not to
the relay's configuration — while allowing one relay image to serve both outboxes as two
separately-deployed Lambdas with different `OUTBOX_TABLE` values (ADR-024).

**Not yet routed:** no EventBridge rule matches `OrderConfirmed` or `OrderFailed`, because no
consumer exists. The events reach the bus and match nothing, which is the correct behaviour for
a published event with no subscribers and is the decoupling the bus exists to provide. The
Notification service will add the rule and its queue.

**Test coverage** (`tests/test_orders.py`, 26 tests, against throwaway `OrdersTest` and
`OrderOutboxTest` tables, with the HTTP clients replaced by in-memory doubles so that each
downstream failure mode can be injected deterministically):

| Test | Proves |
|---|---|
| `test_health` | Health endpoint works. |
| `test_checkout_confirms_the_order` | The happy path reaches `CONFIRMED`, each step ran exactly once, nothing was compensated. |
| `test_total_is_computed_server_side_from_catalogue_prices` | 2 × 10.00 + 3 × 2.50 = `"27.50"`, priced from the catalogue, serialised as a string. |
| `test_client_supplied_price_is_ignored` | A `unit_price` in the request body does not affect the total. |
| `test_confirmed_order_publishes_an_outbox_event` | `OrderConfirmed` written with the correct envelope, `event_source` and `status: PENDING`. |
| `test_confirmed_order_leaves_the_recovery_index` | `saga_status` is absent after `CONFIRMED`, and `/orders/stuck` is empty. |
| `test_insufficient_stock_rejects_without_charging` | 409 from reserve → `REJECTED`, no charge, no release. |
| `test_rejected_order_publishes_order_failed` | A rejection emits `OrderFailed`. |
| `test_reserve_timeout_records_stock_unknown` | A timeout → `STOCK_UNKNOWN`, **no release attempted**, no event. |
| `test_declined_payment_releases_stock_and_fails` | 402 → stock released → `FAILED`, with `payment_id` recorded. |
| `test_failed_compensation_is_a_visible_terminal_state` | Decline + failed release → `COMPENSATION_FAILED`, stays in the index, emits no event. |
| `test_unknown_payment_does_not_release_or_refund` | `PAYMENT_UNKNOWN` performs neither compensating action. |
| `test_unknown_payment_is_distinct_from_declined` | The same step failing two ways yields two states and two different decisions — ADR-034 in one assertion. |
| `test_confirm_failure_refunds_the_payment` | Confirm fails → refund issued → `FAILED`. |
| `test_confirm_failure_with_failed_refund_is_compensation_failed` | Charged customer, no goods, refund failed → `COMPENSATION_FAILED`. |
| `test_confirm_timeout_records_stock_unknown_with_payment` | Confirm timeout → `STOCK_UNKNOWN` retaining `payment_id`, no refund. |
| `test_unknown_product_is_rejected_without_creating_an_order` | 409, no order, no reserve. |
| `test_deactivated_product_is_rejected_with_its_own_message` | A withdrawn product yields a different message from a missing one. |
| `test_catalogue_unavailable_returns_503` | Pricing failure returns 503 (safely retryable), not 500. |
| `test_empty_basket_is_rejected` | 422 at the model boundary, no order. |
| `test_zero_quantity_is_rejected` | 422 at the model boundary. |
| `test_state_transition_requires_the_expected_current_state` | The conditional write refuses to advance an order out of a state it has already left — the duplicate-run guard. |
| `test_get_missing_order_returns_404` | Unknown id returns 404. |
| `test_list_orders_by_customer_is_newest_first` | The customer GSI returns only that customer's orders, newest first. |
| `test_list_orders_paginates` | Cursor pagination across the customer index. |
| `test_stuck_orders_lists_every_needs_attention_state` | Both `PAYMENT_UNKNOWN` and `STOCK_UNKNOWN` appear, proving the per-status query loop. |

**Not tested:** the saga against real HTTP services (the clients are doubles in every test, so
`clients.py`'s own status-code mapping is exercised only indirectly); a genuine mid-saga process
crash, as opposed to an injected downstream failure; the `set_status_and_publish` transaction
failing on its outbox condition rather than its status condition.

---


## 3. Event-Driven Architecture

### The dual-write problem

Creating a product involves two independent systems: a DynamoDB write (the product record) and
an EventBridge publish (the `ProductCreated` event). There is no shared transaction between
them, so a naive "write then publish" has four possible outcomes:

1. Write succeeds, publish succeeds — correct.
2. Write fails, publish never attempted — correct (nothing happened).
3. Write fails, publish somehow still happens — creates an event referencing a product that
   doesn't exist. A downstream consumer (e.g. Inventory) would create a stock record for a
   product with no catalogue entry — active corruption, not mere absence.
4. **Write succeeds, publish fails** — the dangerous case. The product exists, but no event was
   ever sent. No consumer, no operator, and no retry mechanism knows this happened, because
   nothing recorded that a publish was ever owed. The product silently has no inventory record,
   discovered only when someone tries to sell it.

ADR-020 identifies outcome 4 as the one that must be structurally prevented.

### The transactional outbox

`repository.create_product()` writes the product and an outbox record in a single
`TransactWriteItems` call (two `Put` operations, one per table). The actual EventBridge publish
cannot be made atomic with the DynamoDB write — there is no two-phase commit between DynamoDB
and EventBridge, and rolling back a publish that has already reached a consumer is meaningless.
What *can* be made atomic is the **decision to publish**, because recording that decision (the
outbox row) and writing the product are both DynamoDB operations inside the same table's
storage layer. The product therefore cannot exist without a corresponding outbox record, and a
separate process (the relay) guarantees the event is eventually published. This converts an
unbounded failure (event lost forever, undetected) into a bounded one (event delayed until the
relay succeeds).

The design deliberately *increases* duplicate delivery: the relay can call `events:PutEvents`
successfully and then crash before its own `REMOVE status` `update_item` completes, so the
outbox record is still `PENDING` and gets republished on the next stream trigger or recovery
pass. This is an accepted trade rather than an oversight — at-least-once delivery already
requires every consumer to be idempotent (ADR-022; verified in `create_stock_record`, §2.2), so
the outbox's job is only to guarantee no event is lost, not to guarantee it is sent exactly
once. Neither the outbox alone nor consumer idempotency alone would be sufficient: the outbox
without idempotent consumers would just relocate data corruption from "lost events" to
"duplicate side effects"; idempotent consumers without the outbox would still permanently lose
events that were never published in the first place.

The outbox record shape, written by `create_product()`:
```json
{
  "event_id": "<uuid4>",
  "event_type": "ProductCreated",
  "payload": "<JSON string of the event envelope>",
  "created_at": "<ISO-8601 UTC>",
  "status": "PENDING"
}
```

### The relay Lambda

The `product-outbox` table has `stream_enabled = true`, `stream_view_type = "NEW_IMAGE"`
(`terraform/outbox.tf`) — every insert or update delivers the full new item image to the stream,
not just the changed attributes. An `aws_lambda_event_source_mapping`
(`terraform/lambda_relay.tf`) triggers the relay on new stream records, with `batch_size = 10`
and `maximum_batching_window_in_seconds = 1`.

**Self-trigger guard:** when the relay finishes publishing a record, it `REMOVE`s the `status`
attribute (rather than setting it to e.g. `"PUBLISHED"`) and sets `published_at`/`ttl`. That
`update_item` call is itself a `MODIFY` event on the stream, which would re-trigger the relay
with the same record — except its `NewImage` no longer has a `status` key, and the handler's
very first content check (`if "status" not in item: skipped += 1; continue`) discards it. Without
this guard the relay would reprocess its own writes forever. This was verified in the AWS
console via Lambda's built-in recursive-invocation detection metric, which reported no data —
i.e. no self-triggering loop was observed in practice. The design notes supplied for this
document add a specific observation — invocation logs showing "a 212ms cold invocation followed
by a 1.23ms warm one that did nothing." `[UNVERIFIED]` — no log export or screenshot capturing
these figures exists anywhere in this repository; they are recorded as reported, not as
something independently confirmed here. The recursive-invocation metric result is the only part
of this verification this document can trace to a source (`docs/PROJECT_BRIEF.md`).

### The sparse GSI

`terraform/outbox.tf` defines a global secondary index, `pending-index`, with hash key `status`
and range key `created_at`. Because `status` is `REMOVE`d rather than set to a terminal value
on publish, a published record no longer has a value for the GSI's key attribute at all — and a
DynamoDB GSI only indexes items that have a value for every one of its key attributes. A
published record therefore drops out of the index entirely. In a healthy system, `pending-index`
contains only records that are genuinely awaiting publication; it is empty (or near-empty) most
of the time, and any entry that persists is, by construction, something that needs attention.

**Why the GSI exists despite the relay being stream-driven:** DynamoDB Streams retain records
for 24 hours only. If the relay were down or erroring for longer than that, any outbox records
whose stream events aged out of that window would never trigger the relay again through the
stream path — the item would sit in the table, correctly marked `PENDING`, with no mechanism to
notice it. The GSI provides the query path a separate recovery process would need to find and
re-drive those records. `[UNVERIFIED]` — no such recovery process (script or scheduled Lambda)
exists in the repository; the index is currently provisioned but unused. This is noted as a
limitation in §8.

### The event contract

Every event carries a common envelope (ADR-021): `event_id` (a UUID generated once, at
publication, so both copies of a redelivered message carry the same value — this is the
consumer's deduplication key), `event_version` (`"1.0"` — lets a consumer branch on schema
version rather than break when fields are added), `occurred_at` (explicit UTC via
`datetime.now(timezone.utc).isoformat()`, since messages can arrive out of order and a naive
local timestamp would be ambiguous across regions), and a `data` object carrying only what the
consumer needs — for `ProductCreated`, `product_id` and `name`. This payload size is a deliberate
middle position: an ID-only event would force the consumer into a synchronous callback to fetch
the rest, reintroducing the coupling the event was meant to remove; a full-entity event (the
whole `Product` record) would leak the publisher's data model into every consumer and go stale
the moment the product is edited after the event was sent. Field names inside `data` are
fully qualified (`product_id`, not `id`) because an event leaves the context that made a short
name unambiguous. The event source string, `smartretailx.catalogue`, is a Python module
constant in both the publisher (`app/events.py`, currently unused dead code — see §8) and the
relay, not environment configuration, since it is a fixed part of the contract, identical in
every environment.

### EventBridge routing

`aws_cloudwatch_event_rule.product_created` (`terraform/events.tf`) matches:
```json
{ "source": ["smartretailx.catalogue"], "detail-type": ["ProductCreated"] }
```
against the bus `smartretailx-dev-events`, and targets the `inventory` SQS queue. A
`sqs_queue_policy` scopes `sqs:SendMessage` to `events.amazonaws.com`, further restricted by
`ArnEquals` on `aws:SourceArn` to this one rule's ARN — no other EventBridge rule in the account
can deliver to this queue.

The rule's `event_pattern` (Terraform) and the values the relay actually publishes
(`EVENT_SOURCE` in `product-service/app/events.py`/`outbox-relay/app/handler.py`, and the
`event_type` stored in the outbox record) are two independent pieces of code with nothing that
cross-checks them against each other. If they ever drifted apart — a typo in either the
constant string or the Terraform pattern — the failure would be silent: `events:PutEvents` would
still return success, the event simply would not match any rule and would be dropped with no
error raised anywhere. `[UNVERIFIED — structural risk inferred from the code, not an observed
incident]`: nothing in this repository currently shows this mismatch having happened.

### SQS configuration

`aws_sqs_queue.inventory`: `visibility_timeout_seconds = 30`, `message_retention_seconds =
345600` (4 days). `redrive_policy` points at `aws_sqs_queue.inventory_dlq`
(`message_retention_seconds = 1209600`, 14 days — the DynamoDB/SQS maximum), with
`maxReceiveCount = var.dlq_max_receive_count`, default `3`. `[UNVERIFIED]` — the Terraform
variable's description states only "Failed processing attempts before a message moves to the
DLQ"; no code comment documents why 3 specifically was chosen over another small integer.

### Consumer idempotency

`inventory-service`'s `create_stock_record()` is the consumer-side half of the idempotency
contract (ADR-022): a conditional `put_item` that treats `ConditionalCheckFailedException` (the
record already exists) as a successful no-op, not an error. This matters specifically because
SQS is at-least-once: a consumer that processes a message successfully but crashes before
deleting it will see that message again. If redelivery were treated as an error, the Lambda
would report batch failure, SQS would redeliver again, and after `maxReceiveCount` attempts the
message — despite having been processed correctly the first time — would be routed to the DLQ
as if it had failed.

### A representative `ProductCreated` message

No literal captured message (log export, screenshot text, or fixture) exists in this
repository — the following is reconstructed from the code that produces it (the `event_payload`
dict in `product-service/app/repository.py`, combined with AWS's documented standard envelope
for an EventBridge event delivered to SQS) and is marked accordingly.

The `data` field is exactly what the code produces. The outer EventBridge envelope fields
(`id`, `account`, `time`, `region`, `resources`) are `[UNVERIFIED — representative, not
observed]`; only their *shape* is standard AWS behaviour, not their literal values.

```json
{
  "version": "0",
  "id": "<UNVERIFIED — EventBridge-assigned>",
  "detail-type": "ProductCreated",
  "source": "smartretailx.catalogue",
  "account": "<UNVERIFIED>",
  "time": "<UNVERIFIED>",
  "region": "eu-west-1",
  "resources": [],
  "detail": {
    "event_id": "3f2a1c4e-...",
    "event_version": "1.0",
    "occurred_at": "2026-08-14T12:00:00.000000+00:00",
    "data": {
      "product_id": "9d7e...",
      "name": "Product 12"
    }
  }
}
```
The SQS message's `body` is this entire JSON document as a string; the consumer reads
`json.loads(record["body"])["detail"]["data"]["product_id"]`.

---

## 4. Infrastructure

All resources below are defined in `terraform/`. Nothing in AWS was created outside Terraform
(ADR-026) — Terraform cannot see resources it did not create, since its state file is its only
memory of what exists; a hand-built resource produces an "already exists" error on `apply`
rather than being adopted. `locals.prefix = "${var.project_name}-${var.environment}"`
(`smartretailx-dev` in the only environment currently applied) is prepended to every resource
name. Terraform state is never committed to this repository (confirmed via `git ls-files` and
`terraform/.gitignore`, detailed under `dev.tfvars` below) because it stores resource
attributes, including potentially sensitive ones, in plaintext; a team setting would need an S3
backend with encryption, versioning, and DynamoDB state locking, none of which is configured
here (there is a single local developer, so this has not been a practical need).

**`main.tf`:** `terraform { required_version >= 1.5 }`, AWS provider `~> 5.0`, region from
`var.aws_region`, `default_tags` applying `Project`/`Environment`/`ManagedBy: terraform` to
every resource.

**`variables.tf`:** `environment` (required, no default), `aws_region` (default `eu-west-1`),
`project_name` (default `smartretailx`), `dlq_max_receive_count` (default `3`).

**`dev.tfvars`:** the only file overriding a variable — `environment = "dev"`. No
`staging.tfvars` or `production.tfvars` exists. Verified via `terraform/.gitignore` and `git
ls-files`: `*.tfstate`, `*.tfstate.*`, `.terraform/`, `.terraform.lock.hcl`, and `*.tfvars`
(with a carve-out for a committed `example.tfvars`, which does not exist) are all git-ignored.
`dev.tfvars` and `.terraform.lock.hcl` both exist on disk but are confirmed **not** tracked by
git — a fresh clone of this repository has no `.tfvars` file at all, committed example or
otherwise, and would need `environment` supplied from scratch to run `terraform apply`. This is
a genuine reproducibility gap the "everything is Terraform" narrative (ADR-026) does not by
itself cover — the *configuration* is fully in code, but one required input file to actually
apply it is not.

**`events.tf`:**
- `aws_cloudwatch_event_bus.main` — the business event bus (ADR-004).
- `aws_sqs_queue.inventory_dlq` — created before the main queue since it's referenced by ARN;
  `message_retention_seconds = 1209600`, the 14-day maximum, so a failed message can be
  inspected for as long as possible before it's lost.
- `aws_sqs_queue.inventory` — `visibility_timeout_seconds = 30`; redrive to the DLQ at
  `maxReceiveCount = 3`.
- `aws_cloudwatch_event_rule.product_created` + `aws_cloudwatch_event_target` — routes matching
  events to the inventory queue.
- `aws_sqs_queue_policy.inventory` — least-privilege: only `events.amazonaws.com`, only via this
  specific rule's ARN, may `sqs:SendMessage`.

**`outbox.tf`:**
- `aws_dynamodb_table.product_outbox` — `PAY_PER_REQUEST`; hash key `event_id` (S); attributes
  also declared for `status` (S) and `created_at` (S) because they're used as GSI keys.
  `stream_enabled = true`, `stream_view_type = "NEW_IMAGE"` — full item on every change, needed
  by the relay to read the outbox record's other fields, not just the changed keys.
  `global_secondary_index "pending-index"` (hash `status`, range `created_at`, `projection_type
  = "ALL"`) — the sparse recovery index described in §3. `ttl { attribute_name = "ttl", enabled
  = true }` — published records expire automatically 7 days after publication, bounding table
  growth without a manual cleanup job.

**`tables.tf`:**
- `aws_dynamodb_table.products` — `PAY_PER_REQUEST`, hash key `id` (S),
  `point_in_time_recovery { enabled = true }` — continuous backups (restore to any point in the
  last 35 days), protecting against accidental deletion or corruption without a manual backup
  schedule.
- `aws_dynamodb_table.inventory` — identical pattern, hash key `product_id` (S).
- `aws_dynamodb_table.payments` — identical pattern, hash key `payment_id` (S),
  `point_in_time_recovery { enabled = true }`. The design notes for this document argue that
  point-in-time recovery is "non-negotiable on payments", since financial records need a
  near-zero RPO; that argument is now implemented rather than merely asserted. An earlier
  revision of this document recorded the payments table as absent — it has since been added.
- `aws_dynamodb_table.orders` — hash key `order_id` (S), `point_in_time_recovery` enabled,
  plus two global secondary indexes: `customer-orders-index` (hash `customer_id`, range
  `created_at`) for per-customer listing, and `saga-status-index` (hash `saga_status`, range
  `created_at`), a sparse recovery index using the same technique as the outbox's
  `pending-index` — `saga_status` is removed on reaching a healthy terminal state, so the
  index contains only in-flight orders and those requiring manual reconciliation.

**`vpc.tf` — the network:**

Address plan, `10.0.0.0/16`:

| Subnet | CIDR | AZ | Tier | What runs there |
|---|---|---|---|---|
| `smartretailx-dev-private-app-eu-west-1a` | `10.0.1.0/24` | eu-west-1a | private | Lambda ENIs |
| `smartretailx-dev-private-app-eu-west-1b` | `10.0.2.0/24` | eu-west-1b | private | Lambda ENIs |
| `smartretailx-dev-public-web-eu-west-1a` | `10.0.101.0/24` | eu-west-1a | public | ALB tier (ECS target state) — created, unused |
| `smartretailx-dev-public-web-eu-west-1b` | `10.0.102.0/24` | eu-west-1b | public | ALB tier — created, unused |
| *(reserved)* | `10.0.201.0/24`, `10.0.202.0/24` | — | isolated | A relational data tier, if one is ever introduced. Not created: DynamoDB is managed and has no VPC presence. |

The third octet identifies the tier and the last pair maps to the AZ index,
so `10.0.1.x` and `10.0.101.x` are always the same availability zone.

AZ names are constructed directly from `var.aws_region` (`"${var.aws_region}a"`,
`"${var.aws_region}b"`) rather than resolved via a `data.aws_availability_zones`
lookup. Every standard AWS region follows the `<region>a`/`<region>b` suffix
convention, so this needs no per-region logic: pointing `var.aws_region` at
`ap-south-1` for the CP-031 DR run produces `ap-south-1a`/`1b` with no other
file changing. The trade-off, accepted deliberately: a data-source lookup
would additionally confirm those specific AZs are actually available for the
account before planning, which direct string construction does not.

**Routing.** `public-web-rt` has a default route to an internet gateway.
`private-app-rt` has **no default route at all** — only the VPC-local route
and the DynamoDB gateway endpoint. There is no NAT gateway anywhere in the
configuration.

That absence is the design, not a cost compromise. Every destination the
application talks to is an AWS service; a NAT gateway would route that
traffic onto the public internet and straight back in at roughly £30/month
for no gain. VPC endpoints keep it on the AWS backbone, and an attacker
achieving code execution inside a Lambda has no egress path at all — no
route to a command-and-control host and none to exfiltrate over. This is the
concrete form of the Zero Trust argument rather than an assertion of it.

**VPC endpoints.**
- `dynamodb` — Gateway type, attached to the private route table. Free;
  implemented as a route-table entry rather than an ENI, which is why it
  binds to a route table and not to a subnet or security group.
- `events` — Interface type, one ENI per private subnet, `private_dns_enabled`.
  The two outbox relays publish to EventBridge through it.

Deliberately absent, each for a specific reason:
- **SQS** — the inventory consumer is *triggered* by SQS but never calls it.
  The Lambda service polls the queue from outside the VPC and invokes the
  function with the messages already in hand.
- **execute-api** — drafted, then removed on checking the constraint. An
  `execute-api` interface endpoint with private DNS serves **private REST
  APIs only**, and API Gateway HTTP APIs cannot be private at all. Enabling
  it would have made the public gateway *unreachable* from the VPC rather
  than reachable. This is why the Order function is the one Lambda left
  outside the VPC (below).
- **CloudWatch Logs** — not required. A function's log output is collected
  by the Lambda service outside the customer VPC, not written over its ENI.

**Lambda placement.** Six of the seven functions run in the private subnets:
`product-api`, `inventory-api`, `payment-api`, `inventory-consumer`,
`outbox-relay`, `order-outbox-relay`. `order-api` is deliberately outside.
Its saga calls Inventory and Payment through the public API Gateway URL, and
with no `execute-api` endpoint available that would require a NAT gateway
purely to leave AWS and come straight back. Rejected alternatives are
recorded in `lambda_http_services.tf`: a NAT gateway (cost, and it
reintroduces the egress path the design removes), a private REST API (the
frontend could no longer reach it), and direct `lambda:InvokeFunction`
(abandons the local/deployed parity the public-URL decision was made for).
The residual risk is bounded and stated: one function has internet egress
where six have none; it holds no credentials and its role reaches only the
orders tables.

Both private subnets carry a `Services` tag listing exactly what runs
there — the same six function names above — and both public subnets carry
`Services = "reserved-ecs-fargate-alb"`. This is documentation, not network
segmentation: all six in-VPC Lambdas share this one tier and its one
security group; they're isolated from each other by IAM role and
DynamoDB table (database-per-service), not by subnet boundary. The tag
exists so the subnet is self-documenting about its occupants without
implying a per-service network split that doesn't exist.

**Security groups.** `lambda-sg` has **no ingress rule at all** — nothing
connects to a Lambda over the network, since API Gateway and SQS invoke it
through the Lambda service. Egress is 443 only, to two destinations: the VPC
CIDR for the interface endpoints, and the `com.amazonaws.eu-west-1.dynamodb`
managed prefix list.

That second rule was a bug caught before deployment and is worth recording,
because it is counter-intuitive: a gateway endpoint changes the **route**,
not the destination address. Traffic to DynamoDB is still addressed to
DynamoDB's public IP range, so an egress rule allowing only `10.0.0.0/16`
looks tighter and silently blocks every database call in the system.
Security groups can reference managed prefix lists (network ACLs cannot),
so the rule is scoped to DynamoDB's published ranges rather than opened to
`0.0.0.0/0`.

`vpc-endpoints-sg` admits 443 from `lambda-sg` **by security group ID**, not
by CIDR — a CIDR rule would admit anything that happened to hold an address
in range, whereas a group reference admits only resources actually carrying
that group.

**Network ACLs.** A stateless second layer at the subnet boundary, beneath
the stateful security groups. Because they are stateless, return traffic is
not implied: each allowed outbound connection needs a matching inbound rule
for the ephemeral range 1024–65535. The private ACL allows 443 outbound to
`0.0.0.0/0` for the same gateway-endpoint addressing reason above — ACLs
cannot reference prefix lists — but denies every other port and protocol,
and permits no inbound connection on any management port from anywhere.

**Flow logs.** All traffic, to a CloudWatch log group with 14-day retention.
The IAM role's trust policy names `vpc-flow-logs.amazonaws.com`; a
`lambda.amazonaws.com` trust policy here fails silently, creating the flow
log and never delivering a record. Beyond detection, this is what converts
the no-egress claim into evidence: logs showing only endpoint traffic and no
attempts at a public destination prove the design, where a route table with
something missing from it merely argues for it.

**Deployed identifiers (`eu-west-1`, `dev`, account `194680606132`, applied
2026-08-15).** The network is not just written — it now exists. Real
AWS-assigned IDs, not Terraform resource names:

| Resource | Name | ID / ARN |
|---|---|---|
| VPC | `smartretailx-dev-vpc` | `vpc-0c0948833aab4bc70` |
| Private subnet (`eu-west-1a`) | `smartretailx-dev-private-app-eu-west-1a` | `subnet-0132e39cf49cfeb9b` |
| Private subnet (`eu-west-1b`) | `smartretailx-dev-private-app-eu-west-1b` | `subnet-051b44bf6ccaa65d3` |
| Public subnet (`eu-west-1a`) | `smartretailx-dev-public-web-eu-west-1a` | `subnet-01c721f7c3d4002d3` |
| Public subnet (`eu-west-1b`) | `smartretailx-dev-public-web-eu-west-1b` | `subnet-0ff06dade5d6c7e53` |
| Internet gateway | `smartretailx-dev-igw` | `igw-016377aec6d3b1799` |
| Private route table | `smartretailx-dev-private-app-rt` | `rtb-070076d3c5dcd8534` |
| Public route table | `smartretailx-dev-public-web-rt` | `rtb-03442c6549af18da4` |
| Lambda security group | `smartretailx-dev-lambda-sg` | `sg-0e72a9f72d6c06ddc` |
| Endpoint security group | `smartretailx-dev-vpc-endpoints-sg` | `sg-0dd51ba614419827a` |
| Private NACL | `smartretailx-dev-private-app-nacl` | `acl-0f4cdf5159a184ca8` |
| Public NACL | `smartretailx-dev-public-web-nacl` | `acl-058670b1f82f184b4` |
| DynamoDB endpoint (Gateway) | `smartretailx-dev-dynamodb-endpoint` | `vpce-0ab56fe1724f5be0a` |
| EventBridge endpoint (Interface) | `smartretailx-dev-events-endpoint` | `vpce-0ccda29180db51864` |
| WAF web ACL | `smartretailx-dev-web-acl` | `1697c0df-80b9-47cc-adc0-4c6b948663d5` |

(IP ranges for each subnet are in the address-plan table above — `10.0.1.0/24`
through `10.0.102.0/24`.)

The six in-VPC Lambdas' `vpc_config` attachment and the CloudFront/S3 frontend
hosting stack below both showed as pending in the `terraform plan` run
immediately after the network was created (§7, Problem 10) and required a
second apply. As of that second apply, `terraform plan` returns **`No
changes. Your infrastructure matches the configuration.`** — confirmed via
`terraform state show` on `product-api`, `inventory-api`, and `payment-api`,
each carrying a `vpc_config` block with `security_group_ids =
["sg-0e72a9f72d6c06ddc"]` and both private subnet IDs; `order-api` correctly
carries none.

**`hosting.tf` — the public edge:**

One CloudFront distribution serves both the React build and the API:
`/*` to a private S3 bucket via Origin Access Control, `/api/*` to API
Gateway. Routing the API through the same distribution eliminates CORS
entirely (one origin), and is the only way to attach a WAF at all — WAFv2
supports CloudFront, ALB and REST APIs, but **not** API Gateway HTTP APIs.

- **S3** — public access blocked four ways, versioned, SSE enabled. Static
  website hosting deliberately not used: it requires a publicly readable
  bucket and serves plain HTTP.
- **Origin Access Control**, not the legacy Origin Access Identity. The
  bucket policy grants read to the CloudFront service principal narrowed by
  `AWS:SourceArn` to this one distribution — without that condition, any
  distribution in any AWS account could read the bucket.
- **`/api/*` behaviour** uses the managed *CachingDisabled* cache policy and
  the *AllViewerExceptHostHeader* origin request policy. The latter is
  essential: forwarding the `Host` header makes API Gateway see the
  CloudFront hostname, match no API, and reject every request.
- **403 and 404 both rewrite** to `/index.html` with status 200, for
  client-side routing. Handling only 404 leaves the SPA broken on refresh,
  because a private bucket returns 403 for a missing object.
- **WAF** in `us-east-1` with `scope = CLOUDFRONT` — a web ACL for a
  distribution is not a regional resource. Common rule set, known-bad-inputs
  rule set, and a per-IP rate limit of 2000. The rate limit matters
  particularly here: each checkout attempt makes three downstream calls and
  several conditional writes, and holds stock in a reservation, so
  unthrottled traffic costs money *and* makes the catalogue unbuyable.
- **PriceClass_100** (North America and Europe edges only) — named
  explicitly so it reads as a cost decision rather than a default (ADR-012).

**Deployed identifiers (`eu-west-1`, `dev`, applied 2026-08-15):** S3 bucket
`smartretailx-dev-frontend-194680606132` (bucket name includes the account ID
— see §7, Problem 11 for why a plain `smartretailx-dev-frontend` failed),
CloudFront distribution `E22UOLCAMETWJ`, served at
`https://d1vxg10hlsklfv.cloudfront.net`, Origin Access Control `ENKQ6F587SD9Q`,
WAF web ACL `smartretailx-dev-web-acl`
(`arn:aws:wafv2:us-east-1:194680606132:global/webacl/smartretailx-dev-web-acl/1697c0df-80b9-47cc-adc0-4c6b948663d5`,
attached — `us-east-1` because a CloudFront-scope web ACL is always created
there regardless of the distribution's own region).

**`ecr.tf`:**
- `aws_ecr_repository.product_service`, `aws_ecr_repository.outbox_relay` — both
  `image_tag_mutability = "MUTABLE"` (ADR-027: correct tagging discipline would use immutable,
  unique tags per build, but that adds friction during rapid iteration; the accepted cost is
  that Terraform cannot detect a new push to `:latest` as drift, so redeploying requires an
  explicit `aws lambda update-function-code` call — see the working-commands note in
  `PROJECT_BRIEF.md`). Both have `image_scanning_configuration { scan_on_push = true }` —
  automatic vulnerability scanning on every push.
- `aws_ecr_lifecycle_policy` for each — `imageCountMoreThan 5` → `expire`, keeping only the 5
  most recent images per repository so storage cost doesn't grow unbounded (ADR-012).

**`lambda_relay.tf`:**
- `aws_iam_role.outbox_relay` — trust policy allowing `lambda.amazonaws.com` to assume it.
- `aws_iam_role_policy.outbox_relay` — see the exact statements quoted in §5.
- `aws_lambda_function.outbox_relay` — `package_type = "Image"`, `image_uri =
  "${ecr_repo_url}:latest"`, `timeout = 30`, `memory_size = 256`, environment `EVENT_BUS_NAME`
  and `OUTBOX_TABLE` (both interpolated from the actual bus/table resources, not hardcoded
  strings).
- `aws_cloudwatch_log_group.outbox_relay` — explicit log group at `/aws/lambda/<function_name>`
  with `retention_in_days = 14`. Without this, Lambda auto-creates a log group with no expiry —
  unbounded log storage cost.
- `aws_lambda_event_source_mapping.outbox_stream` — `starting_position = "LATEST"` rather than
  `TRIM_HORIZON`: a first deployment of this mapping starts consuming only new stream records
  from that point forward, rather than reprocessing the entire (up to 24-hour) existing stream
  backlog. `batch_size = 10`, `maximum_batching_window_in_seconds = 1`, `maximum_retry_attempts
  = 3`. No on-failure destination is configured for this mapping — after 3 retries a failing
  batch has no documented landing place (flagged in §8).

**`lambda_inventory_consumer.tf`:**
- `aws_ecr_repository.inventory_service` + lifecycle policy — same MUTABLE/scan-on-push/5-image
  pattern.
- `aws_iam_role.inventory_consumer` + `aws_iam_role_policy.inventory_consumer` — see §5.
- `aws_lambda_function.inventory_consumer` — same image as the inventory HTTP service, but
  `image_config { command = ["app.consumer.handler"] }` overrides the image's default `CMD
  ["app.main.handler"]` — the "one image, two Lambdas, entry point chosen at deploy time"
  pattern (ADR-024). Environment: `INVENTORY_TABLE` only (no `EVENT_BUS_NAME` — this Lambda
  never publishes).
- `aws_cloudwatch_log_group.inventory_consumer` — 14-day retention, same pattern.
- `aws_lambda_event_source_mapping.inventory_queue` — `batch_size = 10`,
  `maximum_batching_window_in_seconds = 5` (looser than the relay's 1-second window, tolerating
  more latency in exchange for larger batches).

**`outputs.tf`:** `event_bus_name`, `inventory_queue_url`, `inventory_dlq_url`,
`products_table_name`, `inventory_table_name`, `outbox_table_name`, `ecr_product_service_url`,
`ecr_outbox_relay_url`.

**Environment parameterisation (ADR-016):** because every resource name is derived from
`local.prefix`, a `staging` environment would be produced by running the identical Terraform
configuration with a `staging.tfvars` setting `environment = "staging"` — every table, queue,
bus, Lambda, and ECR repository would be created fresh under a `smartretailx-staging-*` prefix,
fully isolated from `dev`, with no code changes. No such file exists yet; only `dev` has ever
been applied.

---

## 5. Security

**IAM (account-level):** `docs/PROJECT_BRIEF.md` records that the AWS account has root MFA, a
dedicated IAM admin user, and a budget alert. `[UNVERIFIED]` — none of this is defined in
Terraform (it is manual account setup, consistent with ADR-026's carve-out that account-level
identity bootstrapping predates the infrastructure-as-code discipline applied to everything
else); this repository contains no artifact recording the admin user's exact permissions, MFA
enforcement, or key rotation policy. `scripts/env-aws.ps1` and every local `terraform apply`/
`aws` CLI invocation rely on the ambient AWS CLI credentials on the developer's machine — i.e. a
long-lived IAM user access key, which is a weaker credential model than the temporary,
auto-rotated credentials used by deployed Lambda code (below). This is the acknowledged
weakness ADR-025 explicitly designs around for the deployed side, but does not — and cannot —
remove for local/CLI operations. The honest position, as the design notes for this document
frame it: local development only, scoped to a single MFA-protected IAM user, immediately
revocable if compromised. This document can verify one part of that directly — no AWS access
key ID or secret appears anywhere in this repository's tracked files (`scripts/env-aws.ps1`
sets only table/region/bus names and unsets `DYNAMODB_ENDPOINT`; no `.env` file or hardcoded
credential exists anywhere in `backend/` or `scripts/`). Whether the key is in fact scoped to a
single MFA-protected user or is readily revocable is `[UNVERIFIED]` — those are operational
facts about the AWS account, not something a file in this repository can attest to.

**Credential provider chain:** every service's `repository.py` builds one shared
`_dynamodb_kwargs` dict (ADR-025). `region_name` is always set. `endpoint_url` and dummy
`aws_access_key_id`/`aws_secret_access_key = "local"` are added only `if
config.DYNAMODB_ENDPOINT`. When unset — the case in every deployed Lambda — boto3 falls through
to its default credential provider chain, which inside a Lambda execution environment resolves
to the execution role's temporary credentials, injected by the Lambda service itself via
environment variables and rotated automatically. No deployed code path contains a long-lived
AWS credential.

**Least privilege — exact IAM policy statements:**

`aws_iam_role_policy.outbox_relay`:
```
logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents   → arn:aws:logs:*:*:*
dynamodb:GetRecords, GetShardIterator, DescribeStream, ListStreams → product_outbox.stream_arn
dynamodb:UpdateItem                                             → product_outbox.arn
events:PutEvents                                                 → event bus arn
```
Deliberately absent: any permission on the `products` or `inventory` tables; any SQS
permission; `dynamodb:PutItem`, `DeleteItem`, `Scan`, or `Query` on the outbox table itself —
the relay only ever reads via the stream and updates existing items, never creates or deletes
one.

`aws_iam_role_policy.inventory_consumer`:
```
logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents   → arn:aws:logs:*:*:*
sqs:ReceiveMessage, DeleteMessage, GetQueueAttributes           → inventory queue arn
dynamodb:PutItem                                                → inventory table arn
```
Deliberately absent: `GetItem`, `UpdateItem`, `Query`, `Scan` on the inventory table. This role
can create a new stock record and nothing else — it cannot read stock levels, reserve, release,
or confirm. If the inventory HTTP API were ever deployed under this same role, every operation
except `add_stock`'s initial-creation path would fail with an access-denied error. This is
recorded as a known gap in `docs/PROJECT_BRIEF.md`.

**PCI scope reduction (ADR-007, ADR-036):** the `PaymentProvider` interface
(`app/providers/base.py`) is the structural boundary: `charge()` accepts `amount: Decimal` and
`payment_token: str`, never any card field. `Payment` (`app/models.py`) has no field for card
data at all, and `payment_token` itself is never persisted — the model doesn't carry it, and no
`put_item`/`update_item` call in `repository.py` writes it. Verified by source inspection: a
case-insensitive search of `backend/services/payment-service/` for `card|pan|cvv|cvc|expiry|
exp_month|exp_year|number` returns only: the comment `# PSP token — never a card number
(ADR-007)` in `models.py`; the docstring in `providers/base.py` explaining the boundary; the
generic string `"Card declined by issuer"` in `providers/mock.py`; and one incidental substring
match (the word "discard", which contains "card") in `repository.py`. No PAN, CVV, or expiry
field or value exists anywhere in the service. What is stored: `transaction_reference` (an
opaque PSP-issued string) and `amount`. What is not stored: `payment_token`, or anything
resembling raw card data. The design notes for this document frame the trade-off as "removing
the data beats protecting the data," citing SAQ D (in-house card storage) as roughly 300
controls against SAQ A-EP (tokenisation) — `[UNVERIFIED]`: this repository's own documentation
(`ADR-007`) argues the same direction but does not cite a specific control count; the "~300" figure
is not sourced from anything in this codebase and is presented here as the design notes'
figure, not one this document independently confirmed. §2.3 additionally confirms
`payment_token` is never logged anywhere in `payment-service`'s `repository.py`.

**Encryption in transit:** `[UNVERIFIED beyond SDK defaults]` — no code in this repository
explicitly configures TLS. All AWS API calls (DynamoDB, EventBridge, SQS, Lambda, ECR) go
through boto3, which uses HTTPS endpoints by default; this is a platform default being relied
upon, not a deliberate configuration in this project.

**Encryption at rest:** `[UNVERIFIED beyond platform defaults]` — none of the `aws_dynamodb_table`
resources in `tables.tf` or `outbox.tf` declare a `server_side_encryption` block. DynamoDB has
encrypted all tables at rest by default (AWS-owned key) since 2018; this project relies on that
default rather than configuring it explicitly. ADR-019 discusses customer-managed KMS keys as a
mitigation for Schrems II concerns (US ownership of AWS notwithstanding EU data residency), but
this is target-state reasoning, not something configured anywhere in Terraform.

**Authentication and authorisation:** not implemented. There is no Cognito integration, no JWT
validation, no API key check, and no auth middleware anywhere in `backend/services/`. Every
endpoint in every deployed and undeployed service is completely open. Cognito is designed
(ADR-003) — direct sign-in plus a small federation demo, groups mapped to RBAC roles — but is
listed as not-yet-deployed work in `docs/PROJECT_BRIEF.md`'s Next Steps.

---

## 6. Testing

| Suite | Test count | Notes |
|---|---|---|
| `product-service/tests/test_products.py` | 16 | Listed in §2.1; 6 cover the batch price lookup. |
| `inventory-service/tests/test_inventory.py` | 20 | Listed in §2.2; 12 cover the all-or-nothing batch operations. |
| `payment-service/tests/test_payments.py` | 14 | Listed in §2.3. |
| `order-service/tests/test_orders.py` | 26 | Listed in §2.5; covers every branch of the saga. |
| `outbox-relay` | 0 | No `tests/` directory exists. |
| `tests/k6/oversell_test.js` | 1 load-test scenario | See below. |

**76 automated unit/integration tests total** across the four HTTP services, each run with
`pytest` against a per-test throwaway DynamoDB Local table (created and torn down by an
`autouse` fixture), requiring `DYNAMODB_ENDPOINT` to be set explicitly before the app module is
imported in every suite. Tests act as promotion gates in the project's stated methodology
(ADR-015) — a service is not considered to have earned promotion to the next environment until
its suite passes there. All three suites require a live DynamoDB Local instance; none currently
run without it. `docs/PROJECT_BRIEF.md`'s Next Steps (`CI/CD`) currently commits to running
`amazon/dynamodb-local` as a CI service container for this reason. `moto` (a Python library for
mocking AWS services without a live emulator) was considered as an alternative in an earlier
draft of that document within this project's own history, but the current, live version of
`docs/PROJECT_BRIEF.md` no longer mentions it — the service-container approach is the presently
recorded decision, not moto. No CI configuration of any kind exists yet (§8), so neither
approach has actually been implemented.

**k6 concurrency test** (`tests/k6/oversell_test.js`): scenario `flash_sale`, executor
`per-vu-iterations`, 200 virtual users, 1 iteration each, `maxDuration: 30s`. Each VU sends one
`POST http://127.0.0.1:8081/api/v1/inventory/test-product-1/reserve?quantity=1`; the only
in-script assertion is that each response is 200 or 409. The recorded result, per
`docs/PROJECT_BRIEF.md` (this document did not itself re-execute the test): 200 concurrent
reservation attempts against 100 units of stock produced exactly 100 successes and 100
rejections, with final `available_quantity = 0` — zero oversell.

**Correctness properties covered by automated tests:**
- Oversell prevention under 200-way concurrency (k6 + `test_reserve_more_than_available_is_rejected`).
- Idempotent, atomic stock reserve/release/confirm.
- Partial product update leaves unspecified fields untouched.
- Soft-delete visibility (excluded by default, visible with `include_inactive`, restored on
  reactivation) and backward compatibility with pre-existing records lacking `active`.
- Cursor-based pagination correctness across two pages.
- Payment refund idempotency, including an exact-timestamp equality check across two calls.
- Payment PENDING → UNKNOWN transition on a provider exception, and the resulting 500 plus
  stored record.
- `already_refunded` never appearing in a stored item, verified via a raw `boto3.get_item`, not
  the API (so serialization defaults can't hide the field's true absence).

**Correctness properties not covered by any automated test:**
- The outbox `TransactWriteItems` call's atomicity (no test simulates a partial failure).
- The outbox relay Lambda — no test suite exists for it at all, including the self-trigger
  guard, which is verified only by a CloudWatch metric observation, not a test.
- The inventory SQS consumer / `create_stock_record` — not exercised by any test.
- EventBridge rule pattern matching and the full cross-service event flow — verified manually in
  the AWS console, not by an automated test.
- Any authentication or authorisation (none exists).
- The Order saga (the service does not exist).
- Genuinely concurrent duplicate refund requests racing against the `ConditionExpression` (the
  idempotency behaviour is tested only for sequential repeated calls).

---

## 7. Problems Encountered and How They Were Resolved

**1. Lambda rejected the container image with an unsupported media type.**
*Symptom:* deploying a locally built image to Lambda failed. The design notes supplied for this
document quote the error as "The image manifest, config or layer media type for the source
image is not supported." `[UNVERIFIED]` — this exact string does not appear in any file in this
repository (no log capture or error transcript is saved anywhere); it is recorded here as
reported, not as something this document independently confirmed. *Root cause:* Docker BuildKit's
default output is an OCI image manifest with attestation/provenance layers attached; Lambda's
container image support requires the Docker v2 Schema 2 manifest format and rejects the OCI
variant. *Fix:* build with `docker build --provenance=false -t <name> .` — documented as a
required flag in `docs/PROJECT_BRIEF.md`'s working-commands section. *Illustrates:* a platform
compatibility gap between a modern default toolchain behaviour (BuildKit's attestation-by-default)
and an older, stricter consumer (Lambda's image runtime) — the kind of integration detail that
doesn't appear in either tool's basic documentation.

**2. DynamoDB Local silently showed different tables to different tools.**
*Symptom:* a table created by one process appeared to not exist when queried by another.
*Root cause:* without `-sharedDb`, DynamoDB Local partitions its storage by the AWS access key
used in the request. Local scripts authenticate with the dummy `"local"` credentials; a direct
AWS CLI query typically uses the developer's real configured credentials — two different
partitions, each seeing its own, apparently-independent set of tables. *Fix:*
`docker-compose.yml` runs DynamoDB Local with `command: "-jar DynamoDBLocal.jar -inMemory
-sharedDb"`, forcing a single shared partition regardless of which credentials are used.
*Illustrates:* a tool's default behaviour (per-credential partitioning, a reasonable design for
DynamoDB Local's own multi-tenant testing use case) becoming a footgun once local tooling and
CLI inspection use different credentials for the same logical database.

**3. `logging.basicConfig()` is a no-op inside the Lambda runtime — fixed in one deployed
Lambda, not the other.**
Python's `logging.basicConfig()` only takes effect if the root logger has no handlers already
attached; AWS Lambda's Python runtime attaches a handler to the root logger before user code is
imported, so a bare `logging.basicConfig(level=logging.INFO, ...)` call in application code has
no effect once deployed — it only behaves as intended locally, where no prior handler exists.
**Correction to the design notes supplied for this document:** the claim that this was "fixed by
calling `logger.setLevel` on the module's own logger" is **verified true, but only for one of
the two currently-deployed Lambdas.** `inventory-service/app/consumer.py` (the SQS consumer,
deployed) does exactly this — `logger = logging.getLogger(__name__)` followed by
`logger.setLevel(logging.INFO)`, with no `logging.basicConfig()` call anywhere in that file. This
works regardless of the runtime's pre-existing root logger configuration, because `setLevel` on
a named logger determines whether *that logger* emits a record at all; the record still
propagates up to whatever handler Lambda has already attached to the root. `outbox-relay/app/
handler.py` (also deployed) was **not** given the same treatment — it still calls
`logging.basicConfig(level=logging.INFO)` and then `logger = logging.getLogger(__name__)`,
the exact pattern that is a no-op on Lambda. `product-service/app/main.py` has the same
unfixed pattern, but product-service isn't deployed to Lambda, so it has not manifested there.
`[UNVERIFIED]` — no captured CloudWatch log export exists in this repository confirming the
relay's INFO logs are actually missing in practice; this is inferred from the code pattern, not
observed directly. *Illustrates:* a fix applied once, in the file where the problem was first
noticed, does not automatically propagate to structurally identical code elsewhere in the same
codebase — the relay Lambda is left with the same latent defect the consumer was fixed for.

**4. A trailing zero disappeared when sending currency as a JSON number.**
*Symptom:* a test sending `25.00` as a JSON number received `25.0` back. *Root cause:* Python's
standard JSON parser converts a JSON number to a `float` before Pydantic ever sees it, so
`25.00` becomes the binary float `25.0` and the trailing zero — along with exact decimal
precision — is lost before a `Decimal` can be constructed from it. *Fix:* every monetary value
in every request body across all three services is sent as a JSON **string** (`"25.00"`), which
Pydantic parses directly into an exact `Decimal`; this is documented as ADR-039 and followed
consistently in every test file. *Illustrates:* the fix was found by a failing test, not
predicted in advance — direct evidence that currency-as-float is not a hypothetical risk but a
reproducible defect, which is why the codebase uses `Decimal` throughout and DynamoDB (which has
no native float type) rejects Python floats outright.

**5. Environment variables set after starting `uvicorn` never reached the running process.**
*Symptom:* setting an environment variable in the same PowerShell session as a running dev
server had no effect. *Root cause:* `uvicorn --reload`'s file-watching reloader runs the actual
application in a child process, which inherits the parent's environment only at the moment it is
spawned; a variable set afterward in the parent shell does not propagate to an already-running
child. *Fix:* documented convention in `docs/PROJECT_BRIEF.md` — dot-source the environment
script (`. scripts\env-local.ps1` or `. scripts\env-aws.ps1`) *before* starting `uvicorn`, since
dot-sourcing runs in the current shell so the variables persist there first. *Illustrates:* a
process-model detail (parent/child environment inheritance at spawn time, not by reference)
that is invisible until you specifically try to change configuration on a live reloading
server.

**6. Changing `DYNAMODB_ENDPOINT`'s default to `None` broke every test suite until they were
updated.**
*Symptom:* after `config.py` was changed so `DYNAMODB_ENDPOINT` has no default (previously
`"http://localhost:8000"`), running the test suites without further changes would have caused
them to construct a `boto3` client with no `endpoint_url` and no explicit local override — for a
service running purely against DynamoDB Local, this reaches for real AWS instead. *Fix:* each
test file (`test_products.py`, `test_inventory.py`, `test_payments.py`) explicitly sets
`os.environ["DYNAMODB_ENDPOINT"] = "http://localhost:8000"` before importing the application
module, so config picks it up at import time. The design notes supplied for this document assert
the failure would have been `UnrecognizedClientException`; `[UNVERIFIED]` — plausible for an
invalid AWS access key ID against a real regional endpoint, but no error transcript is saved in
this repository confirming the exact exception. **Correction:** the notes also claim that, "had
the credentials been valid, the inventory suite would have created and then deleted a table in a
real account." This does not describe what the test fixtures as written can actually do: each
fixture builds its own `boto3.resource(...)` call with `aws_access_key_id="local",
aws_secret_access_key="local"` hardcoded unconditionally — not read from the environment, not
inherited from `repository.py`'s conditional logic. Even with `DYNAMODB_ENDPOINT` unset
(resolving to a real AWS endpoint), the literal string `"local"` is not a valid AWS access key,
so the request would fail authentication before ever reaching a real table — it could not
succeed in creating or deleting anything. The genuine version of this risk applies to
*application* code that resolves credentials from the real environment rather than hardcoding
dummy ones (which is exactly why `repository.py`'s `_dynamodb_kwargs` pattern is conditional in
the first place, per ADR-025) — not to these specific test fixtures. *Why the new default is
still safer despite the breakage:* a deployment that forgets to set `DYNAMODB_ENDPOINT` in Lambda
now reaches real AWS and works (using the execution role's real credentials) rather than
silently hanging or failing against a `localhost` address that has no meaning inside a Lambda
container — the failure mode moved from "silently wrong in production" to "loudly wrong in tests
until fixed," which is the direction ADR-025 argues configuration defaults should be chosen.

**7. Code review found the payment provider was called before any record was written.**
*Symptom (found during a structured code review, not a runtime incident):* the original
`charge()` called `get_provider().charge(...)` first and only constructed and wrote the
`Payment` record after the provider returned. *Root cause:* this ordering means any exception
from the provider call — a real PSP's network timeout after the card was actually charged, for
example — leaves no record that a charge was ever attempted, let alone that it might have
succeeded. *Fix:* `charge()` was restructured to write a `PENDING` record via `put_item` first,
then call the provider inside a `try/except Exception`, transitioning the record to `SUCCEEDED`,
`FAILED`, or (on an exception) `UNKNOWN` with the exception text as `failure_reason`, re-raising
afterward. This is documented as ADR-034. *Illustrates:* "record intent, then act" versus "act,
then record" is not a stylistic preference — it determines whether an unrecoverable failure mode
(silent, undetectable data loss) or a recoverable one (an explicit record requiring
reconciliation) results from the same underlying fault.

**8. A refund landing during the new `PENDING` window called the provider with a null
transaction reference — a deny-list versus allow-list lesson.**
*Symptom (again found by review, before it could occur in practice):* introducing `PENDING` as
a real, externally observable status (problem 7) meant `refund()`'s pre-check — which explicitly
rejected `FAILED` and, once added, `UNKNOWN` — let anything *not* on that list fall through to
calling `provider.refund(payment.transaction_reference, ...)`. A `PENDING` record has no
`transaction_reference` yet, so this would call the provider with `None`, the exact defect
already fixed for `FAILED` payments. *Root cause:* the pre-check was structured as a deny-list
(name the known-bad statuses, allow everything else through) rather than an allow-list (name the
one known-good status, reject everything else). A deny-list fails open: introducing a new status
value requires *remembering* to add it to the rejection list, and forgetting is silent. *Fix:* an
explicit `if payment.status == "PENDING": raise ValueError(...)` guard was added alongside
`FAILED` and `UNKNOWN`. *Illustrates:* the general lesson — a deny-list of rejected states is
inherently fragile against new states being introduced later; an allow-list of permitted states
(here, "proceed only if `SUCCEEDED`") would have caught this automatically, at the cost of an
explicit rejection message for each excluded case. The deny-list approach was kept (each status
gets its own tailored error message), but the lesson is recorded because the same class of bug
could recur if a further status is ever added without updating this function.

**9. Terraform could not create the inventory consumer Lambda in a single `apply`.**
`aws_lambda_function.inventory_consumer` (`terraform/lambda_inventory_consumer.tf`) is defined
with `package_type = "Image"` and `image_uri = "${aws_ecr_repository.inventory_service.
repository_url}:latest"` in the same Terraform configuration that creates the ECR repository
itself. Terraform can create the (empty) repository, but it cannot push an image into it — that
step is `docker build`/`docker push`, done outside Terraform (the same 3-step deploy process
described in `docs/PROJECT_BRIEF.md`: build with `--provenance=false`, push to ECR, then
`update-function-code`). A Lambda function referencing `:latest` in a repository that has never
had anything pushed to it has no image to reference. `[UNVERIFIED — inferred from the
Terraform dependency structure, not from a captured error log]`: the necessary consequence is
that `terraform apply` must run once to create the ECR repository, an image must then be built
and pushed outside Terraform, and only then can `apply` run a second time to actually create the
Lambda function. *Illustrates:* a structural chicken-and-egg dependency between
infrastructure-as-code and container-image publishing that Terraform's dependency graph cannot
resolve on its own, because "does this ECR repository contain a usable image" is not a fact
Terraform's plan/apply cycle tracks.

**Trailing zeros were being lost on the way out of DynamoDB.**
*Symptom:* after the Order service was built, `test_batch_get_returns_requested_products` failed
with `assert '20.5' == '20.50'`, and two order tests failed the same way (`'27.5'` for `27.50`,
`'20'` for `20.00`). *Root cause:* DynamoDB stores numbers in a canonical form and discards
trailing zeros. A price written as `Decimal("20.50")` reads back as `Decimal("20.5")`, which
Pydantic then serialised faithfully as `"20.5"`. ADR-039 had addressed the JSON-parsing half of
the trailing-zero problem — transmit strings, never JSON numbers — but not the storage half.
*Why it had not surfaced before:* the pre-existing suites passed by accident of their test data.
`19.99` has no trailing zero to lose; `20.50` does. The bug had been latent in the Product and
Payment services since they were written. *Resolution:* a Pydantic `field_serializer` on every
monetary field quantizing to two decimal places on output (ADR-039, as amended). No stored value
changes and no arithmetic changes — `quantize` only pads, so `30.89` stays `30.89` — only the
wire format is made independent of how DynamoDB chose to store the number. *Illustrates:* the
value of running the suites against DynamoDB Local rather than an in-process emulator. The same
tests passed against an emulator, which did not reproduce DynamoDB's numeric normalisation; the
choice of test double was itself load-bearing, and a green suite against the wrong double is
weaker evidence than it appears.

**10. A Lambda's `vpc_config` attachment did not appear in the same `terraform plan` that
created the VPC it depends on.**
*Symptom:* after adding `vpc.tf` and setting `in_vpc = true` on `product-api`, `inventory-api`,
and `payment-api` (all three already deployed, previously with no VPC at all) plus the three
Lambdas in `lambda_relay.tf`/`lambda_inventory_consumer.tf`/`order_outbox.tf`, the plan that
created the VPC, subnets, and security groups reported `30 to add, 6 to change` — and none of
the six Lambda functions were in either list, despite their config now specifying a
`vpc_config` block that did not exist in state at all. The IAM permissions those same functions
needed to join the VPC (`ec2:CreateNetworkInterface` etc., from `local.vpc_access_statement`)
*did* show correctly as policy updates in that same plan. *Root cause:* `vpc_config`'s
`subnet_ids` and `security_group_ids` reference `aws_subnet.private[*].id` and
`aws_security_group.lambda.id` — resources being created in this same plan, so their values are
unknown until apply actually runs. For this specific computed, optional nested block, Terraform's
plan renderer does not surface the pending change while every value inside it is unknown; the
IAM policy statement, by contrast, is fully computable at plan time (nothing inside it depends
on a not-yet-created resource), so it shows normally. *Fix:* apply once to create the VPC and
its dependencies, then run `plan`/`apply` a second time — with the subnet and security-group IDs
now real and in state, the same `vpc_config` diff becomes visible and applies normally.
*Illustrates:* the same structural class of problem as Problem 9 (the ECR-image/Lambda ordering
issue), surfaced in a more dangerous form: not as an outright plan error, but as a silently
incomplete plan. Nothing about a clean `apply` here indicates that a second one is still owed —
this can only be caught by explicitly re-running `plan` and checking, which is why this record
does it explicitly rather than trusting a single "no errors" apply.

**11. The frontend S3 bucket name collided with a bucket owned by an unrelated AWS account.**
*Symptom:* `terraform apply` failed creating `aws_s3_bucket.frontend` with `BucketAlreadyExists`
(HTTP 409) on the name `smartretailx-dev-frontend`. *Root cause:* S3 bucket names are a single
namespace shared across every AWS account globally, not scoped per-account — unlike almost every
other resource type Terraform manages here. `${local.prefix}-frontend` is a short, predictable
name with nothing account-specific in it, and some other, entirely unrelated AWS account already
held it. (`BucketAlreadyExists` specifically indicates another account owns it;
`BucketAlreadyOwnedByYou` would have indicated a collision with this same account instead.)
*Fix:* added `data "aws_caller_identity" "current" {}` and renamed the bucket to
`"${local.prefix}-frontend-${data.aws_caller_identity.current.account_id}"` —
`smartretailx-dev-frontend-194680606132`. Every other resource in `hosting.tf` already referenced
the bucket via `aws_s3_bucket.frontend.id`/`.arn`/`.bucket_regional_domain_name` rather than the
literal string, so nothing else needed to change. *Illustrates:* a resource-naming assumption
(project+environment prefix is sufficient) that holds for every other AWS resource type in this
configuration and silently breaks for the one type with a global rather than per-account
namespace — worth checking for explicitly rather than assuming uniform naming rules across
resource types.

**12. `viewer_certificate.minimum_protocol_version` caused a perpetual apply/plan drift loop.**
*Symptom:* `terraform plan`, run again immediately after a clean apply with no configuration
changes in between, kept reporting `aws_cloudfront_distribution.main` as needing an update —
indefinitely, on every subsequent plan. *Root cause:* `hosting.tf` set
`cloudfront_default_certificate = true` (the default `*.cloudfront.net` certificate — a custom
domain is deferred to CP-030) alongside `minimum_protocol_version = "TLSv1.2_2021"`. AWS only
honours a custom minimum TLS version when the distribution uses a custom ACM certificate; with
the default certificate, it silently forces `TLSv1` server-side regardless of what Terraform
sends, and does not error when a different value is submitted. Each apply pushed
`TLSv1.2_2021`, AWS silently reverted it to `TLSv1`, and the next plan saw a genuine diff between
config and real state and proposed pushing `TLSv1.2_2021` again — a stable two-state
oscillation, not a transient issue. *Fix:* removed `minimum_protocol_version` from the
`viewer_certificate` block entirely, letting it default to what AWS was already enforcing.
Confirmed with `terraform plan` returning `No changes. Your infrastructure matches the
configuration.` immediately afterward. *Illustrates:* not every value AWS's API accepts is a
value AWS's API will actually keep — some fields are conditionally enforced based on a sibling
field's value, and the API stays silent about the substitution rather than rejecting the
combination outright. A single successful `apply` does not prove a configuration is stable;
only a second `plan` with zero changes does.

---

## 8. Known Limitations

### Deliberate scope decisions

- ECS Fargate/EKS is designed as Terraform + Kubernetes manifests and validated locally on
  `kind`, but never deployed to managed EKS (ADR-001) — cost.
- Full warm-standby multi-region DR (Route 53 failover, standby compute) is designed only
  (ADR-010); no `aws_dynamodb_table` in this repository configures Global Tables replicas.
- Full Cognito federation is designed (ADR-003) but not deployed; there is currently no
  authentication of any kind, deployed or otherwise (§5).
- Products are soft-deleted (`active` flag) with no hard-delete endpoint, by design (ADR-037).
- `MockPaymentProvider` stands in for a real PSP; the abstraction (ADR-036) is designed so that
  adding a real provider requires one new class and one factory branch, but no real provider is
  integrated.

### Gap between a stated ADR decision and actual implementation

- ADR-008 states SSM Parameter Store (SecureString) is used for configuration secrets in the
  deployed slice. `[UNVERIFIED against actual usage]` — no file in `backend/` calls the SSM API
  (`boto3.client("ssm")` does not appear anywhere in the codebase); every piece of configuration
  currently comes from plain Lambda environment variables set directly by Terraform. Either no
  secret currently exists that would need Parameter Store, or the decision has not yet been
  acted on — the repository does not distinguish between these.

### Genuine gaps

- **The system is single-currency and the currency is implicit.** All amounts are US dollars
  (USD); no model carries a currency code. Two decimal places is assumed everywhere — in the
  `decimal_places=2` validation, in the serialisation quantization (ADR-039), and implicitly in
  every price in the catalogue. This is a genuine weakness against a brief describing a
  multinational platform across Europe, Asia and the Middle East: an amount without a currency
  is not a well-formed monetary value, and the two-decimal assumption does not hold universally
  (JPY has zero decimal places, KWD and BHD have three, so the quantization would be wrong for
  either). The correct model is an amount paired with an ISO-4217 code with the scale derived
  from the code, plus a decision on whether prices are stored per-currency or converted at
  display time. Deferred on time; recorded so the assumption is stated rather than unexamined.
- Evidence capture (screenshots, logs) is significantly behind the actual build — only two
  screenshots exist in `evidence/screenshots/`, both for the Product service, despite
  substantially more having been built and deployed since.
- The inventory consumer's IAM role grants only `dynamodb:PutItem`; deploying the inventory HTTP
  API as a Lambda under the same role would fail on every read/update operation (§5).
- The table-creation scripts (`scripts/create_*.py`) hardcode a `DYNAMODB_LOCAL_ENDPOINT`
  defaulting to `http://localhost:8000` and always pass dummy credentials, unconditionally —
  unlike the services' own `repository.py` files, which are environment-conditional. This is
  intentional (these scripts are local-only tooling; AWS tables come from Terraform), but it
  means they cannot be pointed at a real AWS table by unsetting an environment variable the way
  the services can.
- The outbox relay Lambda has no test suite at all.
- The inventory SQS consumer (`consumer.py`, `create_stock_record`) has no dedicated test.
- `payment-service`'s `refund()` contains two branches in its `ConditionalCheckFailedException`
  handler that are effectively unreachable in the current codebase (no delete operation exists
  to trigger the "record not found" branch; the final `ValueError` is worded for a "failed"
  payment though it is only realistically reached via a `REFUNDED` race) — identified in code
  review, left unchanged as harmless.
- No compensation retry queue exists for the (as yet undesigned-in-code) Order saga;
  `COMPENSATION_FAILED` (ADR-035) is a decision recorded for future work, not something any
  current code implements, since the Order service does not exist.
- The Payment service has never been deployed to AWS in any form (no Lambda, no ECR image, no
  API Gateway route). Its DynamoDB table is, however, now provisioned in Terraform with
  point-in-time recovery enabled.
- The Product and Inventory HTTP APIs are likewise not deployed behind API Gateway — only their
  auxiliary Lambdas (the outbox relay and the SQS consumer, respectively) are deployed.
- No CI/CD pipeline exists — there is no `.github/` directory or equivalent in this repository.
- `product-service/app/events.py` (`publish_product_created`, a direct-EventBridge-publish
  function) is dead code: it exists on disk but is not imported or called by `main.py`, which
  now calls only `repository.create_product()` — a leftover from the pre-outbox implementation,
  kept per an earlier explicit instruction not to delete it ("the relay Lambda will reuse it"),
  though the relay Lambda in fact does not import or use it either.
- The `pending-index` GSI on the outbox table is provisioned but has no code anywhere that
  queries it — the 24-hour-stream-retention recovery path it exists for is not implemented
  (§3).
- Only one environment (`dev`) has ever been applied; no `staging.tfvars` or
  `production.tfvars` exists, so ADR-016's environment-promotion design is unexercised in
  practice.
- CloudWatch dashboards, alarms, and X-Ray tracing (ADR-009) are designed but not implemented —
  no `aws_cloudwatch_dashboard`, `aws_cloudwatch_metric_alarm` (beyond the account-level billing
  alarm mentioned in `docs/PROJECT_BRIEF.md`), or X-Ray configuration exists in Terraform.
- Order, Notification, and User Profile services do not exist — no code beyond an empty
  placeholder directory for each.
