import { useCallback, useEffect, useState } from "react";
import { fetchMyOrders } from "../api/orders.js";
import ErrorState from "./ErrorState.jsx";
import LoadingState from "./LoadingState.jsx";
import { formatPrice } from "../lib/currency.js";

const CONFIRMATION_STATUSES = new Set(["CONFIRMED", "PENDING_ON_DELIVERY"]);

export default function OrdersPage({ idToken, latestOrder }) {
  const [orders, setOrders] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Re-shows only when a genuinely NEW order arrives (keyed on order_id, see
  // the effect below) — revisiting this page later with the same stale
  // latestOrder won't bring a dismissed banner back.
  const [showConfirmation, setShowConfirmation] = useState(Boolean(latestOrder));
  const latestOrderId = latestOrder?.order_id;

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchMyOrders({ idToken })
      .then((page) => {
        setOrders(page.items || []);
        setCursor(page.next_cursor || null);
      })
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [idToken]);

  useEffect(() => {
    load();
    setShowConfirmation(Boolean(latestOrderId));
  }, [load, latestOrderId]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const page = await fetchMyOrders({ cursor, idToken });
      setOrders((current) => [...current, ...(page.items || [])]);
      setCursor(page.next_cursor || null);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) return <LoadingState label="Loading your orders…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <section>
      <p className="text-sm font-medium text-brand-700">Customer account</p>
      <h2 className="mt-1 text-3xl font-bold tracking-tight text-stone-900">Your orders</h2>
      {showConfirmation && latestOrder && CONFIRMATION_STATUSES.has(latestOrder.status) && (
        <div className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm text-brand-800">
          <p>
            <strong>Order placed!</strong>{" "}
            {latestOrder.status === "PENDING_ON_DELIVERY"
              ? "Pay in cash when it arrives."
              : "Your payment was confirmed."}
          </p>
          <button onClick={() => setShowConfirmation(false)} className="shrink-0 font-medium text-brand-700 hover:text-brand-900">
            Dismiss
          </button>
        </div>
      )}
      {orders.length === 0 ? (
        <p className="mt-8 rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center text-stone-500">You have not placed an order yet.</p>
      ) : (
        <div className="mt-6 space-y-4">
          {orders.map((order) => <OrderCard key={order.order_id} order={order} />)}
        </div>
      )}
      {cursor && (
        <div className="mt-6 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-lg border border-brand-600 px-6 py-2.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}

export function OrderCard({ order }) {
  return (
    <article className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><p className="font-semibold text-stone-900">Order placed</p><p className="mt-1 text-sm text-stone-500">{new Date(order.created_at).toLocaleString()}</p></div>
        <StatusBadge status={order.status} />
      </div>
      <ul className="mt-4 space-y-2 border-y border-stone-100 py-4 text-sm text-stone-600">
        {order.items.map((item) => <li key={item.product_id} className="flex justify-between gap-4"><span className="min-w-0 truncate">{item.quantity} × {item.name}</span><span className="shrink-0">{formatPrice(Number(item.unit_price) * item.quantity)}</span></li>)}
      </ul>
      <div className="flex justify-between font-semibold text-stone-900"><span>Total</span><span>{formatPrice(order.total)}</span></div>
      {order.payment_method && (
        <p className="mt-3 text-sm text-stone-500">
          {order.payment_method === "cash_on_delivery" ? "Cash on delivery" : "Paid by card"}
          {order.shipping_address && <> — delivering to {order.shipping_address.city}, {order.shipping_address.country}</>}
        </p>
      )}
      {order.delivery_status && <DeliveryStatus status={order.delivery_status} />}
      {order.failure_reason && <p className="mt-3 text-sm text-red-700">{order.failure_reason}</p>}
    </article>
  );
}

export function StatusBadge({ status }) {
  const warning = String(status).includes("UNKNOWN") || String(status).includes("FAILED") || String(status).includes("REJECTED");
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${warning ? "bg-amber-100 text-amber-800" : "bg-brand-100 text-brand-800"}`}>{status}</span>;
}

// Same order, same wording, as the DeliveryStatusChanged email
// (notification-service/app/emailer.py's _DELIVERY_STATUS_MESSAGES) — a
// customer reading the email and then checking this page should see the
// same language, not two different vocabularies for one thing.
const DELIVERY_STEPS = [
  { value: "PROCESSING", label: "Processing" },
  { value: "SHIPPED", label: "Shipped" },
  { value: "OUT_FOR_DELIVERY", label: "Out for delivery" },
  { value: "DELIVERED", label: "Delivered" },
];

function DeliveryStatus({ status }) {
  const currentIndex = DELIVERY_STEPS.findIndex((step) => step.value === status);

  // An unrecognised value (a future status this UI hasn't been taught yet)
  // still shows something rather than silently rendering nothing.
  if (currentIndex === -1) {
    return <p className="mt-3 text-sm text-stone-500">Delivery status: {status}</p>;
  }

  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-stone-500">Delivery status</p>
      <ol className="mt-2 flex items-center gap-1.5">
        {DELIVERY_STEPS.map((step, index) => (
          <li key={step.value} className="flex flex-1 items-center gap-1.5 last:flex-none">
            <span
              className={`flex flex-col items-center gap-1 ${index <= currentIndex ? "text-brand-700" : "text-stone-300"}`}
            >
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                  index <= currentIndex ? "bg-brand-600" : "bg-stone-200"
                }`}
              />
              <span className="hidden text-xs font-medium sm:block">{step.label}</span>
            </span>
            {index < DELIVERY_STEPS.length - 1 && (
              <span className={`h-0.5 flex-1 ${index < currentIndex ? "bg-brand-600" : "bg-stone-200"}`} />
            )}
          </li>
        ))}
      </ol>
      <p className="mt-1.5 text-xs font-medium text-stone-600 sm:hidden">
        {DELIVERY_STEPS[currentIndex].label}
      </p>
    </div>
  );
}
