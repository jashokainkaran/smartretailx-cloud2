import { useCallback, useEffect, useState } from "react";
import { fetchAllOrdersAdmin, updateDeliveryStatus } from "../api/orders.js";
import { StatusBadge } from "./OrdersPage.jsx";
import { formatPrice } from "../lib/currency.js";

const DELIVERY_STATUSES = ["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"];

// Only a confirmed order has anything to ship — matches the guard
// order-service/app/repository.py's set_delivery_status enforces server-side,
// so the dropdown here is a convenience, not the actual safety check.
const FULFILLABLE_STATUSES = new Set(["CONFIRMED", "PENDING_ON_DELIVERY"]);

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

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const page = await fetchAllOrdersAdmin({ limit: 50, idToken });
      setOrders(page.items || []);
      setCursor(page.next_cursor || null);
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

  const groups = groupByCustomer(orders);

  return (
    <section>
      <p className="text-sm font-medium text-brand-700">Administrator workspace</p>
      <h2 className="mt-1 text-3xl font-bold tracking-tight text-stone-900">Customers &amp; orders</h2>

      {message && <p className="mt-5 rounded-md bg-brand-50 p-3 text-sm text-brand-800">{message}</p>}
      {error && <p className="mt-5 rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}

      {groups.length === 0 ? (
        <p className="mt-8 rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center text-stone-500">
          No orders have been placed yet.
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
      {expanded && (
        <div className="space-y-3 border-t border-stone-100 p-4">
          {group.orders.map((order) => (
            <OrderRow key={order.order_id} order={order} onChangeDelivery={onChangeDelivery} />
          ))}
        </div>
      )}
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
        <label className="mt-2 flex items-center gap-2 text-xs font-medium text-stone-600">
          Delivery status
          <select
            value={order.delivery_status || ""}
            onChange={(event) => onChangeDelivery(order, event.target.value)}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs"
          >
            <option value="" disabled>Not set</option>
            {DELIVERY_STATUSES.map((status) => (
              <option key={status} value={status}>{status.replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
