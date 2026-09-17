import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { fetchAllOrdersAdmin, fetchAttentionOrders, updateDeliveryStatus } from "../api/orders.js";
import { fetchPayment, refundPayment } from "../api/payments.js";
import { StatusBadge } from "./OrdersPage.jsx";
import SelectField from "./SelectField.jsx";
import SuccessNotice from "./SuccessNotice.jsx";
import { formatPrice } from "../lib/currency.js";

const DELIVERY_STATUSES = ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];

// Only a confirmed order has anything to ship — matches the guard
// order-service/app/repository.py's set_delivery_status enforces server-side,
// so the dropdown here is a convenience, not the actual safety check.
const FULFILLABLE_STATUSES = new Set(["CONFIRMED", "PENDING_ON_DELIVERY"]);

function CustomersIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <circle cx="9" cy="8" r="3.25" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.25 3.25 0 0 1 0 6.4" />
      <path d="M18 13.5a6.5 6.5 0 0 1 3.5 5.8" />
    </svg>
  );
}

function AttentionIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function SearchIcon({ className = "h-4 w-4" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

// There is no separate customer-profile store (CP-033, not built) — every
// order already carries the contact_email captured at checkout, so that's
// used as the customer's display identity rather than a live Cognito
// lookup, which would need new IAM permissions this service doesn't have.
function groupByCustomer(orders) {
  const groups = new Map();
  for (const order of orders) {
    const key = order.customer_id;
    if (!groups.has(key)) groups.set(key, { customerId: key, email: null, phone: null, orders: [] });
    const group = groups.get(key);
    group.orders.push(order);
    if (!group.email && order.contact_email) group.email = order.contact_email;
    if (!group.phone && order.contact_phone) group.phone = order.contact_phone;
  }
  return [...groups.values()].sort((a, b) => b.orders.length - a.orders.length);
}

export default function CustomersOrdersPage({ idToken }) {
  const [orders, setOrders] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [attentionOrders, setAttentionOrders] = useState([]);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [page, stuck] = await Promise.all([
        fetchAllOrdersAdmin({ limit: 50, idToken }),
        fetchAttentionOrders(idToken),
      ]);
      setOrders(page.items || []);
      setCursor(page.next_cursor || null);
      setAttentionOrders(stuck || []);
    } catch (loadError) { setError(loadError.message); }
    finally { setLoading(false); }
  }, [idToken]);

  useEffect(() => { load(); }, [load]);

  async function loadMore() {
    setLoadingMore(true); setError(null);
    try {
      const page = await fetchAllOrdersAdmin({ limit: 50, cursor, idToken });
      setOrders((current) => [...current, ...(page.items || [])]);
      setCursor(page.next_cursor || null);
    } catch (loadError) { setError(loadError.message); }
    finally { setLoadingMore(false); }
  }

  async function changeDelivery(order, deliveryStatus) {
    setError(null);
    try {
      const updated = await updateDeliveryStatus(order.order_id, deliveryStatus, idToken);
      setOrders((current) => current.map((o) => (o.order_id === updated.order_id ? updated : o)));
      setMessage(`Order ${order.order_id.slice(0, 8)}… marked ${deliveryStatus.replace(/_/g, " ").toLowerCase()}.`);
    } catch (updateError) { setError(updateError.message); }
  }

  if (loading) return <p className="py-12 text-stone-500">Loading customers…</p>;

  // Searches only what's already loaded, same reasoning as the product
  // table's search — "Load more" builds the working set, filtering it
  // client-side avoids a search endpoint this page otherwise doesn't need.
  const allGroups = groupByCustomer(orders);
  const query = search.trim().toLowerCase();
  const groups = query
    ? allGroups.filter((group) => (group.email || "").toLowerCase().includes(query) || (group.phone || "").toLowerCase().includes(query))
    : allGroups;

  return (
    <section>
      <p className="text-sm font-medium text-brand-700">Administrator workspace</p>
      <h2 className="mt-1 flex items-center gap-2.5 font-serif text-2xl font-semibold tracking-tight text-stone-900 sm:text-3xl">
        <CustomersIcon /> Customers &amp; orders
      </h2>

      {message && <SuccessNotice className="mt-5">{message}</SuccessNotice>}
      {error && <p className="mt-5 rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}

      <div className="mt-6">
        <AttentionOrders orders={attentionOrders} idToken={idToken} onError={setError} onMessage={setMessage} />
      </div>

      {allGroups.length > 0 && (
        <div className="relative mt-6">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search customers by email or phone…"
            aria-label="Search customers by email or phone"
            className="w-full rounded-md border border-stone-300 py-2 pl-9 pr-3 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
        </div>
      )}

      {allGroups.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center text-stone-500">
          No orders have been placed yet.
        </p>
      ) : groups.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center text-stone-500">
          No customers match "{search}".
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          {groups.map((group) => (
            <CustomerGroup
              key={group.customerId}
              group={group}
              expanded={expandedId === group.customerId}
              onToggle={() => setExpandedId((current) => (current === group.customerId ? null : group.customerId))}
              onChangeDelivery={changeDelivery}
            />
          ))}
        </div>
      )}

      {cursor && (
        <div className="mt-6 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-lg border border-brand-600 px-6 py-2.5 text-sm font-medium text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}

function CustomerGroup({ group, expanded, onToggle, onChangeDelivery }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white shadow-sm">
      <button onClick={onToggle} className="flex w-full items-center justify-between gap-3 p-4 text-left">
        <div className="min-w-0">
          <p className="truncate font-semibold text-stone-900">
            {group.email || `Customer ${group.customerId.slice(0, 8)}…`}
          </p>
          <p className="text-xs text-stone-500">
            {group.phone && <>{group.phone} · </>}
            {group.orders.length} order{group.orders.length === 1 ? "" : "s"}
          </p>
        </div>
        <svg
          xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
          className={`h-5 w-5 shrink-0 text-stone-400 transition ${expanded ? "rotate-180" : ""}`}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="space-y-3 border-t border-stone-100 p-4">
              {group.orders.map((order) => (
                <OrderRow key={order.order_id} order={order} onChangeDelivery={onChangeDelivery} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function OrderRow({ order, onChangeDelivery }) {
  const fulfillable = FULFILLABLE_STATUSES.has(order.status);
  return (
    <div className="rounded-lg bg-stone-50 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium text-stone-900">{order.order_id}</span>
        <StatusBadge status={order.status} />
      </div>
      <p className="mt-1 text-stone-500">{new Date(order.created_at).toLocaleString()}</p>
      <ul className="mt-2 space-y-1 border-y border-stone-200 py-2">
        {order.items.map((item) => (
          <li key={item.product_id} className="flex justify-between gap-4">
            <span className="min-w-0 truncate text-stone-700">{item.quantity} × {item.name}</span>
            <span className="shrink-0 text-stone-600">{formatPrice(Number(item.unit_price) * item.quantity)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 flex justify-between font-medium text-stone-900">
        <span>Total</span>
        <span>{formatPrice(order.total)}</span>
      </p>
      {order.failure_reason && <p className="mt-1 text-red-700">{order.failure_reason}</p>}
      {fulfillable && (
        <div className="mt-2 flex items-center gap-2 text-xs font-medium text-stone-600">
          Delivery status
          <div className="w-44">
            <SelectField
              ariaLabel="Delivery status"
              placeholder="Not set"
              value={order.delivery_status || ""}
              onChange={(value) => onChangeDelivery(order, value)}
              options={DELIVERY_STATUSES}
              formatOption={(status) => status.replace(/_/g, " ")}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Orders in PAYMENT_UNKNOWN, STOCK_UNKNOWN or COMPENSATION_FAILED need a
// human to reconcile them — this is the only place in the admin UI that can
// inspect a payment or issue a refund.
function AttentionOrders({ orders, idToken, onError, onMessage }) {
  const [payment, setPayment] = useState(null);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refunding, setRefunding] = useState(false);

  async function inspectPayment(order) {
    if (!order.payment_id) return;
    onError(null);
    try { setPayment(await fetchPayment(order.payment_id, idToken)); }
    catch (lookupError) { onError(lookupError.message); }
  }

  async function refund() {
    if (!payment) return;
    onError(null); setRefunding(true);
    try {
      const result = await refundPayment(payment.payment_id, idToken);
      setPayment(result);
      onMessage(`Refund result: ${result.status}.`);
    } catch (refundError) { onError(refundError.message); }
    finally { setRefunding(false); setRefundOpen(false); }
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <h3 className="flex items-center gap-2 text-lg font-bold text-stone-900">
        <AttentionIcon /> Orders needing attention
      </h3>
      {orders.length === 0 ? (
        <p className="mt-3 text-sm text-stone-500">No orders currently need reconciliation.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {orders.map((order) => (
            <li key={order.order_id} className="rounded-md bg-stone-50 p-3 text-sm">
              <div className="flex justify-between gap-2">
                <span className="min-w-0 break-all font-medium">{order.order_id}</span>
                <span className="shrink-0"><StatusBadge status={order.status} /></span>
              </div>
              {order.payment_id && (
                <button onClick={() => inspectPayment(order)} className="mt-2 font-medium text-brand-700">
                  Inspect payment
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {payment && (
        <div className="mt-4 rounded-md bg-brand-50 p-3 text-sm">
          <p><strong>Payment:</strong> {payment.status}</p>
          <p className="mt-1 text-stone-600">{payment.payment_id}</p>
          {payment.status === "SUCCEEDED" && (
            <AlertDialog.Root open={refundOpen} onOpenChange={setRefundOpen}>
              <AlertDialog.Trigger asChild>
                <button className="mt-3 font-medium text-red-700 hover:text-red-800">Issue refund</button>
              </AlertDialog.Trigger>
              <AlertDialog.Portal>
                <AlertDialog.Overlay className="fixed inset-0 z-30 bg-plum/60 backdrop-blur-sm" />
                <AlertDialog.Content className="fixed left-1/2 top-1/2 z-40 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-luxe focus:outline-none">
                  <AlertDialog.Title className="font-serif text-lg font-semibold text-red-800">Issue this refund?</AlertDialog.Title>
                  <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
                    This refunds payment <strong>{payment.payment_id}</strong> in full. This cannot be undone from here.
                  </AlertDialog.Description>
                  <div className="mt-5 flex gap-3">
                    <button
                      onClick={refund}
                      disabled={refunding}
                      className="rounded-full bg-red-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-800 disabled:opacity-60"
                    >
                      {refunding ? "Refunding…" : "Confirm refund"}
                    </button>
                    <AlertDialog.Cancel asChild>
                      <button className="rounded-full border border-stone-300 px-4 py-2 text-sm font-semibold text-stone-700 transition hover:bg-stone-50">
                        Cancel
                      </button>
                    </AlertDialog.Cancel>
                  </div>
                </AlertDialog.Content>
              </AlertDialog.Portal>
            </AlertDialog.Root>
          )}
        </div>
      )}
    </section>
  );
}
