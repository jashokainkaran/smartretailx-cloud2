import { useCallback, useEffect, useState } from "react";
import { fetchAdminProducts } from "../api/products.js";
import { fetchAttentionOrders, fetchOrderSummary } from "../api/orders.js";
import { fetchLowStock } from "../api/inventory.js";
import { StatusBadge } from "./OrdersPage.jsx";
import ErrorState from "./ErrorState.jsx";
import LoadingState from "./LoadingState.jsx";
import OrderToast from "./OrderToast.jsx";
import { formatPrice } from "../lib/currency.js";
import { useWebSocketMessage } from "../realtime/WebSocketProvider.jsx";

const ORDER_TOAST_LIFETIME_MS = 5000;
const LOW_STOCK_THRESHOLD = 10;

export default function Dashboard({ idToken, onNavigate }) {
  const [products, setProducts] = useState([]);
  const [attentionOrders, setAttentionOrders] = useState([]);
  const [summary, setSummary] = useState(null);
  const [lowStock, setLowStock] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [orderToasts, setOrderToasts] = useState([]);
  // Deliberately separate from summary.total_orders (the true daily total,
  // computed server-side) — this counts only what's arrived over the
  // WebSocket since the dashboard was opened, an honest live-only number,
  // labelled as such rather than implied to be the same thing.
  const [liveResolvedCount, setLiveResolvedCount] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchAdminProducts({ limit: 100, idToken }),
      fetchAttentionOrders(idToken),
      fetchOrderSummary(idToken),
      fetchLowStock(idToken, LOW_STOCK_THRESHOLD),
    ])
      .then(([productPage, stuck, orderSummary, lowStockItems]) => {
        setProducts(productPage.items || []);
        setAttentionOrders(stuck || []);
        setSummary(orderSummary);
        setLowStock(lowStockItems || []);
      })
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [idToken]);

  const pushOrderToast = useCallback((toast) => {
    const key = `${toast.order_id}-${Date.now()}`;
    setOrderToasts((current) => [...current, { ...toast, key }]);
    setTimeout(() => {
      setOrderToasts((current) => current.filter((item) => item.key !== key));
    }, ORDER_TOAST_LIFETIME_MS);
  }, []);

  const handleOrderResolved = useCallback((message) => {
    setLiveResolvedCount((count) => count + 1);
    pushOrderToast({ ...message, type: "OrderResolved" });
    // A newly-resolved COMPENSATION_FAILED/PAYMENT_UNKNOWN/STOCK_UNKNOWN
    // order needs to show up in the attention list live too, not just as a
    // toast that's gone in five seconds — re-fetching is simpler and safer
    // than trying to reconstruct the full order shape from the push payload
    // alone, and this event is rare enough that the extra request is cheap.
    if (message.status && message.status.includes("UNKNOWN")) load();
  }, [pushOrderToast, load]);
  useWebSocketMessage("OrderResolved", handleOrderResolved);

  const handleNeedsReconciliation = useCallback((message) => {
    setLiveResolvedCount((count) => count + 1);
    pushOrderToast({ ...message, type: "OrderNeedsReconciliation" });
    load();
  }, [pushOrderToast, load]);
  useWebSocketMessage("OrderNeedsReconciliation", handleNeedsReconciliation);

  // A live stock tick doesn't change WHICH products are low — only a
  // reserve/release/confirm changes available_quantity enough to matter —
  // but re-fetching the whole low-stock list on every single tick would be
  // wasteful. Re-checking on order resolution (a natural, much lower-
  // frequency point) is a reasonable proxy instead of a dedicated event.
  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingState label="Loading dashboard…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const activeCount = products.filter((product) => product.active).length;
  const inactiveCount = products.length - activeCount;
  const cardCount = summary.by_payment_method.card || 0;
  const codCount = summary.by_payment_method.cash_on_delivery || 0;
  const paymentTotal = cardCount + codCount;

  return (
    <section>
      <OrderToast toasts={orderToasts} />

      <p className="text-sm font-medium text-brand-700">Administrator workspace</p>
      <h2 className="mt-1 text-2xl font-bold tracking-tight text-stone-900 sm:text-3xl">Dashboard</h2>

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-stone-500 sm:mt-8">
        Today
      </h3>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <StatTile
          label="Orders today"
          value={summary.total_orders}
          hint={summary.total_orders > 0
            ? Object.entries(summary.by_status).map(([status, count]) => `${count} ${status.toLowerCase()}`).join(", ")
            : undefined}
        />
        <StatTile label="Revenue today" value={formatPrice(summary.total_revenue)} />
        <StatTile label="Average order value" value={formatPrice(summary.average_order_value)} />
      </div>
      {paymentTotal > 0 && (
        <div className="mt-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
          <p className="text-xs font-medium text-stone-500">Payment method split</p>
          <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-stone-100">
            <div className="bg-brand-600" style={{ width: `${(cardCount / paymentTotal) * 100}%` }} />
            <div className="bg-amber-400" style={{ width: `${(codCount / paymentTotal) * 100}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-xs text-stone-600">
            <span>Card — {cardCount}</span>
            <span>Cash on delivery — {codCount}</span>
          </div>
        </div>
      )}

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-stone-500 sm:mt-8">
        Operations
      </h3>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <StatTile label="Active products" value={activeCount} />
        <StatTile label="Inactive products" value={inactiveCount} />
        <StatTile
          label="Orders needing attention"
          value={attentionOrders.length}
          tone={attentionOrders.length > 0 ? "warning" : "default"}
        />
        <StatTile
          label="Resolved live"
          value={liveResolvedCount}
          hint="Since this page opened"
        />
      </div>

      <div className="mt-6 grid gap-6 sm:mt-8 sm:gap-8 lg:grid-cols-3">
        <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-bold text-stone-900 sm:text-lg">Orders needing attention</h3>
            <button onClick={() => onNavigate("admin")} className="text-sm font-medium text-brand-700 hover:text-brand-900">
              Manage all
            </button>
          </div>
          {attentionOrders.length === 0 ? (
            <p className="mt-4 text-sm text-stone-500">Nothing currently needs reconciliation.</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {attentionOrders.slice(0, 5).map((order) => (
                <li key={order.order_id} className="flex items-center justify-between gap-3 rounded-md bg-stone-50 p-3 text-sm">
                  <span className="min-w-0 truncate font-medium text-stone-900">{order.order_id}</span>
                  <span className="shrink-0"><StatusBadge status={order.status} /></span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-bold text-stone-900 sm:text-lg">Low stock</h3>
            <button onClick={() => onNavigate("admin")} className="text-sm font-medium text-brand-700 hover:text-brand-900">
              Manage stock
            </button>
          </div>
          {lowStock.length === 0 ? (
            <p className="mt-4 text-sm text-stone-500">Nothing at or below {LOW_STOCK_THRESHOLD} units.</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {lowStock.slice(0, 5).map((item) => (
                <li key={item.product_id} className="flex items-center justify-between gap-3 rounded-md bg-stone-50 p-3 text-sm">
                  <span className="min-w-0 truncate font-medium text-stone-900">{item.product_id}</span>
                  <span className="shrink-0 font-semibold text-amber-800">{item.available_quantity} left</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-bold text-stone-900 sm:text-lg">Catalogue</h3>
            <button onClick={() => onNavigate("admin")} className="text-sm font-medium text-brand-700 hover:text-brand-900">
              Manage products
            </button>
          </div>
          <p className="mt-4 text-sm text-stone-600">
            <strong>{products.length}</strong> product{products.length === 1 ? "" : "s"} total
            {products.length >= 100 && " (showing the first 100)"}.
          </p>
        </section>
      </div>
    </section>
  );
}

function StatTile({ label, value, tone = "default", hint }) {
  const toneClass = tone === "warning" && value > 0
    ? "border-amber-300 bg-amber-50 text-amber-900"
    : "border-stone-200 bg-white text-stone-900";
  return (
    <div className={`rounded-xl border p-3 shadow-sm sm:p-5 ${toneClass}`}>
      <p className="text-2xl font-bold sm:text-3xl">{value}</p>
      <p className="mt-1 text-xs text-stone-600 sm:text-sm">{label}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-stone-400">{hint}</p>}
    </div>
  );
}
