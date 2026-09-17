import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { fetchAdminProducts } from "../api/products.js";
import { fetchAttentionOrders, fetchOrderSummary, fetchReadyToShip } from "../api/orders.js";
import { fetchLowStock } from "../api/inventory.js";
import { StatusBadge } from "./OrdersPage.jsx";
import ErrorState from "./ErrorState.jsx";
import LoadingState from "./LoadingState.jsx";
import OrderToast from "./OrderToast.jsx";
import { formatPrice } from "../lib/currency.js";
import { useWebSocketMessage } from "../realtime/WebSocketProvider.jsx";

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: (index = 0) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.05 * index, duration: 0.35, ease: "easeOut" },
  }),
};

function AttentionIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function ShipIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M3 7h11v9H3z" />
      <path d="M14 10h4l3 3v3h-7z" />
      <circle cx="7.5" cy="18" r="1.5" />
      <circle cx="17.5" cy="18" r="1.5" />
    </svg>
  );
}

function LowStockIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M21 8 12 3 3 8l9 5 9-5Z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M9 12h6" />
    </svg>
  );
}

function CatalogueIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function RefreshIcon({ className = "h-4 w-4" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

const ORDER_TOAST_LIFETIME_MS = 5000;
const LOW_STOCK_THRESHOLD = 10;
// The immediate local update makes the UI responsive; half a second gives
// DynamoDB's eventually-consistent indexes a little time before the source
// of truth is re-read.
const LIVE_REFRESH_DEBOUNCE_MS = 500;
const RECENT_EVENT_ID_LIMIT = 200;

async function fetchAllAdminProducts(idToken) {
  const products = [];
  const seenCursors = new Set();
  let cursor;

  do {
    const page = await fetchAdminProducts({ limit: 100, cursor, idToken });
    products.push(...(page.items || []));
    cursor = page.next_cursor || null;

    if (cursor && seenCursors.has(cursor)) {
      throw new Error("Product catalogue pagination returned the same cursor twice.");
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);

  return products;
}

export default function Dashboard({ idToken, onNavigate }) {
  const [products, setProducts] = useState([]);
  const [attentionOrders, setAttentionOrders] = useState([]);
  const [readyToShip, setReadyToShip] = useState([]);
  const [summary, setSummary] = useState(null);
  const [lowStock, setLowStock] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [orderToasts, setOrderToasts] = useState([]);
  const processedEventIdsRef = useRef(new Set());
  const liveRefreshTimerRef = useRef(null);
  const pendingRefreshSectionsRef = useRef(new Set());
  const liveRefreshVersionsRef = useRef(new Map());
  const mountedRef = useRef(true);
  // Deliberately separate from summary.total_orders (the true daily total,
  // computed server-side) — this counts only what's arrived over the
  // WebSocket since the dashboard was opened, an honest live-only number,
  // labelled as such rather than implied to be the same thing.
  const [liveResolvedCount, setLiveResolvedCount] = useState(0);

  const fetchDashboardData = useCallback(() => Promise.all([
    fetchAllAdminProducts(idToken),
    fetchAttentionOrders(idToken),
    fetchOrderSummary(idToken),
    fetchReadyToShip({ idToken }),
    fetchLowStock(idToken, LOW_STOCK_THRESHOLD),
  ]).then(([allProducts, stuck, orderSummary, readyOrders, lowStockItems]) => {
    setProducts(allProducts);
    setAttentionOrders(stuck || []);
    setSummary(orderSummary);
    setReadyToShip(readyOrders || []);
    setLowStock(lowStockItems || []);
  }), [idToken]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchDashboardData().catch((loadError) => setError(loadError.message)).finally(() => setLoading(false));
  }, [fetchDashboardData]);

  // A manual escape hatch, independent of whatever the WebSocket is doing —
  // it reconnects quietly on its own (see WebSocketProvider), so this isn't
  // "fix a broken connection", it's "let an admin who suspects something's
  // stale get a straight answer without a full page reload". Deliberately
  // does NOT set `loading`: the dashboard stays exactly as it was while this
  // runs, rather than blanking to the full-page loading state again.
  const refresh = useCallback(() => {
    setRefreshing(true);
    setError(null);
    fetchDashboardData().catch((refreshError) => setError(refreshError.message)).finally(() => setRefreshing(false));
  }, [fetchDashboardData]);

  // A WebSocket message says that data changed, but it is intentionally not
  // the source of truth. Coalesce a burst of messages into one targeted
  // refresh. Versions are tracked PER SECTION: a new summary event can
  // invalidate an older summary request, but it must never discard an
  // unrelated attention/stock/ready-to-ship response.
  const scheduleLiveRefresh = useCallback((sections) => {
    sections.forEach((section) => {
      pendingRefreshSectionsRef.current.add(section);
      const versions = liveRefreshVersionsRef.current;
      versions.set(section, (versions.get(section) || 0) + 1);
    });
    clearTimeout(liveRefreshTimerRef.current);

    liveRefreshTimerRef.current = setTimeout(() => {
      liveRefreshTimerRef.current = null;
      const sectionsToRefresh = pendingRefreshSectionsRef.current;
      pendingRefreshSectionsRef.current = new Set();
      const requests = [];

      const addRequest = (name, request) => requests.push({
        name,
        version: liveRefreshVersionsRef.current.get(name),
        request,
      });
      if (sectionsToRefresh.has("attention")) addRequest("attention", fetchAttentionOrders(idToken));
      if (sectionsToRefresh.has("summary")) addRequest("summary", fetchOrderSummary(idToken));
      if (sectionsToRefresh.has("readyToShip")) addRequest("readyToShip", fetchReadyToShip({ idToken }));
      if (sectionsToRefresh.has("lowStock")) addRequest("lowStock", fetchLowStock(idToken, LOW_STOCK_THRESHOLD));

      Promise.allSettled(requests.map(({ request }) => request)).then((results) => {
        if (!mountedRef.current) return;
        results.forEach((result, index) => {
          const { name, version } = requests[index];
          if (result.status === "rejected") {
            // One failed section must not prevent the other successful
            // sections in the same refresh batch from updating.
            console.warn(`Live dashboard ${name} refresh failed`, result.reason);
            return;
          }
          if (version !== liveRefreshVersionsRef.current.get(name)) return;
          if (name === "attention") setAttentionOrders(result.value || []);
          if (name === "summary") setSummary(result.value);
          if (name === "readyToShip") setReadyToShip(result.value || []);
          if (name === "lowStock") setLowStock(result.value || []);
        });
      });
    }, LIVE_REFRESH_DEBOUNCE_MS);
  }, [idToken]);

  const shouldHandleEvent = useCallback((message) => {
    // Older queued messages from before this deployment have no event_id.
    // Process them once for backwards compatibility; new messages are
    // de-duplicated for the lifetime of this dashboard session.
    if (!message.event_id) return true;
    const processed = processedEventIdsRef.current;
    if (processed.has(message.event_id)) return false;
    processed.add(message.event_id);
    if (processed.size > RECENT_EVENT_ID_LIMIT) processed.delete(processed.values().next().value);
    return true;
  }, []);

  useEffect(() => {
    // React Strict Mode deliberately mounts, cleans up and mounts effects
    // again in development. Reset this flag on every effect setup so that
    // test behaviour matches the real mounted dashboard.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(liveRefreshTimerRef.current);
    };
  }, []);

  // Inventory owns quantities but does not know whether a catalogue item is
  // active. Join the service-owned data here: known inactive products are
  // excluded from replenishment alerts, while an unknown id remains visible
  // as a safety measure rather than silently hiding a potentially real alert.
  const productById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products]
  );
  const visibleLowStock = useMemo(
    () => lowStock.filter((item) => productById.get(item.product_id)?.active !== false),
    [lowStock, productById]
  );

  const pushOrderToast = useCallback((toast) => {
    const key = `${toast.order_id}-${Date.now()}`;
    setOrderToasts((current) => [...current, { ...toast, key }]);
    setTimeout(() => {
      setOrderToasts((current) => current.filter((item) => item.key !== key));
    }, ORDER_TOAST_LIFETIME_MS);
  }, []);

  const handleOrderResolved = useCallback((message) => {
    if (!shouldHandleEvent(message)) return;
    setLiveResolvedCount((count) => count + 1);
    pushOrderToast({ ...message, type: "OrderResolved" });
    // Make the two visible order indicators feel immediate, then re-read
    // the service-owned truth shortly afterwards (including revenue/AOV).
    setSummary((current) => current && ({
      ...current,
      total_orders: current.total_orders + 1,
      by_status: {
        ...current.by_status,
        [message.status]: (current.by_status[message.status] || 0) + 1,
      },
      by_payment_method: message.payment_method ? {
        ...current.by_payment_method,
        [message.payment_method]: (current.by_payment_method[message.payment_method] || 0) + 1,
      } : current.by_payment_method,
    }));
    if (message.status === "CONFIRMED" || message.status === "PENDING_ON_DELIVERY") {
      setReadyToShip((current) => [
        { order_id: message.order_id, status: message.status },
        ...current.filter((order) => order.order_id !== message.order_id),
      ].slice(0, 5));
    }
    scheduleLiveRefresh(["summary", "readyToShip", "lowStock"]);
  }, [pushOrderToast, scheduleLiveRefresh, shouldHandleEvent]);
  useWebSocketMessage("OrderResolved", handleOrderResolved);

  const handleNeedsReconciliation = useCallback((message) => {
    if (!shouldHandleEvent(message)) return;
    pushOrderToast({ ...message, type: "OrderNeedsReconciliation" });
    scheduleLiveRefresh(["attention"]);
  }, [pushOrderToast, scheduleLiveRefresh, shouldHandleEvent]);
  useWebSocketMessage("OrderNeedsReconciliation", handleNeedsReconciliation);

  const handleDeliveryStatusChanged = useCallback((message) => {
    if (!shouldHandleEvent(message)) return;
    // The update's own payload is enough to remove the order immediately;
    // the delayed fetch reconciles with the eventually-consistent GSI.
    setReadyToShip((current) => current.filter((order) => order.order_id !== message.order_id));
    scheduleLiveRefresh(["readyToShip"]);
  }, [scheduleLiveRefresh, shouldHandleEvent]);
  useWebSocketMessage("DeliveryStatusChanged", handleDeliveryStatusChanged);

  // Restock, reserve, release and confirmation can all move a product
  // across the low-stock threshold. The shared debounce collapses a burst
  // of StockUpdated messages into one authoritative low-stock read.
  const handleStockUpdated = useCallback((message) => {
    if (!shouldHandleEvent(message)) return;
    scheduleLiveRefresh(["lowStock"]);
  }, [scheduleLiveRefresh, shouldHandleEvent]);
  useWebSocketMessage("StockUpdated", handleStockUpdated);

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
      <div className="mt-1 flex items-center justify-between gap-3">
        <h2 className="font-serif text-2xl font-semibold tracking-tight text-stone-900 sm:text-3xl">Dashboard</h2>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-full border border-stone-300 px-3.5 py-2 text-sm font-medium text-stone-700 transition hover:border-stone-400 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshIcon className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">{refreshing ? "Refreshing…" : "Refresh"}</span>
        </button>
      </div>

      <h3 className="mt-6 text-xs font-semibold uppercase tracking-wide text-stone-500 sm:mt-8">
        Today
      </h3>
      <motion.div
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.06 } } }}
        className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4"
      >
        <StatTile
          label="Orders today"
          value={summary.total_orders}
          hint={summary.total_orders > 0
            ? Object.entries(summary.by_status).map(([status, count]) => `${count} ${status.toLowerCase()}`).join(", ")
            : undefined}
        />
        <StatTile label="Revenue today" value={formatPrice(summary.total_revenue)} />
        <StatTile label="Average order value" value={formatPrice(summary.average_order_value)} />
      </motion.div>
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
      <motion.div
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.06, delayChildren: 0.12 } } }}
        className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4"
      >
        <StatTile label="Active products" value={activeCount} />
        <StatTile label="Inactive products" value={inactiveCount} />
        <StatTile
          label="Orders needing attention"
          value={attentionOrders.length}
          tone={attentionOrders.length > 0 ? "warning" : "default"}
        />
        <StatTile
          label="Orders resolved live"
          value={liveResolvedCount}
          hint="Confirmed, rejected or failed while viewing"
        />
      </motion.div>

      <motion.div
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.07, delayChildren: 0.24 } } }}
        className="mt-6 grid gap-6 sm:mt-8 sm:gap-8 lg:grid-cols-4"
      >
        <motion.section variants={fadeUp} className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="flex items-start gap-2 text-base font-bold text-stone-900 sm:text-lg">
              <span className="mt-0.5 shrink-0"><AttentionIcon /></span> Orders needing attention
            </h3>
            <button onClick={() => onNavigate("customers")} className="text-sm font-medium text-brand-700 hover:text-brand-900">
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
        </motion.section>

        <motion.section variants={fadeUp} className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="flex items-start gap-2 text-base font-bold text-stone-900 sm:text-lg">
              <span className="mt-0.5 shrink-0"><ShipIcon /></span> Ready to ship
            </h3>
            <button onClick={() => onNavigate("customers")} className="text-sm font-medium text-brand-700 hover:text-brand-900">
              Manage orders
            </button>
          </div>
          {readyToShip.length === 0 ? (
            <p className="mt-4 text-sm text-stone-500">No confirmed orders are waiting to be shipped.</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {readyToShip.map((order) => (
                <li key={order.order_id} className="flex items-center justify-between gap-3 rounded-md bg-stone-50 p-3 text-sm">
                  <span className="min-w-0 truncate font-medium text-stone-900">{order.order_id}</span>
                  <span className="shrink-0"><StatusBadge status={order.status} /></span>
                </li>
              ))}
            </ul>
          )}
        </motion.section>

        <motion.section variants={fadeUp} className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="flex items-start gap-2 text-base font-bold text-stone-900 sm:text-lg">
              <span className="mt-0.5 shrink-0"><LowStockIcon /></span> Low stock
            </h3>
            <button onClick={() => onNavigate("admin")} className="text-sm font-medium text-brand-700 hover:text-brand-900">
              Manage stock
            </button>
          </div>
          {visibleLowStock.length === 0 ? (
            <p className="mt-4 text-sm text-stone-500">Nothing at or below {LOW_STOCK_THRESHOLD} units.</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {visibleLowStock.slice(0, 5).map((item) => (
                <li key={item.product_id} className="flex items-center justify-between gap-3 rounded-md bg-stone-50 p-3 text-sm">
                  <span className="min-w-0 truncate font-medium text-stone-900">
                    {productById.get(item.product_id)?.name || item.product_id}
                  </span>
                  <span className="shrink-0 font-semibold text-persimmon-700">{item.available_quantity} left</span>
                </li>
              ))}
            </ul>
          )}
        </motion.section>

        <motion.section variants={fadeUp} className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="flex items-start gap-2 text-base font-bold text-stone-900 sm:text-lg">
              <span className="mt-0.5 shrink-0"><CatalogueIcon /></span> Catalogue
            </h3>
            <button onClick={() => onNavigate("admin")} className="text-sm font-medium text-brand-700 hover:text-brand-900">
              Manage products
            </button>
          </div>
          <p className="mt-4 text-sm text-stone-600">
            <strong>{products.length}</strong> product{products.length === 1 ? "" : "s"} total.
          </p>
        </motion.section>
      </motion.div>
    </section>
  );
}

function StatTile({ label, value, tone = "default", hint }) {
  const toneClass = tone === "warning" && value > 0
    ? "border-amber-300 bg-amber-50 text-amber-900"
    : "border-stone-200 bg-white text-stone-900";
  return (
    <motion.div variants={fadeUp} className={`rounded-xl border p-3 shadow-sm sm:p-5 ${toneClass}`}>
      {/* key={value} remounts on every change — a live number landing gets
          a quick pop instead of silently swapping, the one visible cue
          this is a live dashboard and not a static snapshot. */}
      <motion.p
        key={value}
        initial={{ scale: 1.18 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 420, damping: 20 }}
        className="text-2xl font-bold sm:text-3xl"
      >
        {value}
      </motion.p>
      <p className="mt-1 text-xs text-stone-600 sm:text-sm">{label}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-stone-400">{hint}</p>}
    </motion.div>
  );
}
