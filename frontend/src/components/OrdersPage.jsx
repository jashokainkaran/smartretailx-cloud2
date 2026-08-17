import { useCallback, useEffect, useState } from "react";
import { fetchMyOrders } from "../api/orders.js";
import ErrorState from "./ErrorState.jsx";
import LoadingState from "./LoadingState.jsx";
import { formatPrice } from "../lib/currency.js";

export default function OrdersPage({ idToken, latestOrder }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchMyOrders(idToken)
      .then((page) => setOrders(page.items || []))
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [idToken]);

  useEffect(() => { load(); }, [load, latestOrder?.order_id]);

  if (loading) return <LoadingState label="Loading your orders…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <section>
      <p className="text-sm font-medium text-brand-700">Customer account</p>
      <h2 className="mt-1 text-3xl font-bold tracking-tight text-stone-900">Your orders</h2>
      {orders.length === 0 ? (
        <p className="mt-8 rounded-xl border border-dashed border-stone-300 bg-white p-10 text-center text-stone-500">You have not placed an order yet.</p>
      ) : (
        <div className="mt-6 space-y-4">
          {orders.map((order) => <OrderCard key={order.order_id} order={order} />)}
        </div>
      )}
    </section>
  );
}

export function OrderCard({ order }) {
  return (
    <article className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><p className="break-all font-semibold text-stone-900">Order {order.order_id}</p><p className="mt-1 text-sm text-stone-500">{new Date(order.created_at).toLocaleString()}</p></div>
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
      {order.failure_reason && <p className="mt-3 text-sm text-red-700">{order.failure_reason}</p>}
    </article>
  );
}

export function StatusBadge({ status }) {
  const warning = String(status).includes("UNKNOWN") || String(status).includes("FAILED") || String(status).includes("REJECTED");
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${warning ? "bg-amber-100 text-amber-800" : "bg-brand-100 text-brand-800"}`}>{status}</span>;
}
