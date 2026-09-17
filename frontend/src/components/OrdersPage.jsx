import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { fetchMyOrders } from "../api/orders.js";
import { fetchProductById } from "../api/products.js";
import ErrorState from "./ErrorState.jsx";
import ProductImage from "./ProductImage.jsx";
import { formatPrice } from "../lib/currency.js";

const CONFIRMATION_STATUSES = new Set(["CONFIRMED", "PENDING_ON_DELIVERY"]);
const ACTIVE_DELIVERY_STATUSES = new Set(["PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY"]);
const SUPPORT_EMAIL = "support@smartretailx.com";

function sortByDate(orders, direction) {
  return [...orders].sort((a, b) => {
    const diff = new Date(b.created_at) - new Date(a.created_at);
    return direction === "newest" ? diff : -diff;
  });
}

// Consecutive orders that share a calendar month get folded under one
// heading. Only meaningful on an already date-sorted list — it just checks
// "did the month change since the last order", which holds regardless of
// sort direction as long as the list stays chronologically contiguous.
function groupByMonth(orders) {
  const groups = [];
  let currentLabel = null;
  for (const order of orders) {
    const label = new Date(order.created_at).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    if (label !== currentLabel) {
      groups.push({ label, orders: [] });
      currentLabel = label;
    }
    groups[groups.length - 1].orders.push(order);
  }
  return groups;
}

export default function OrdersPage({ idToken, latestOrder, onNavigate }) {
  const [orders, setOrders] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sortDirection, setSortDirection] = useState("newest");
  const [printingOrderId, setPrintingOrderId] = useState(null);
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

  // Isolates one order card for printing (via the .print-receipt rule in
  // index.css) rather than printing the whole page behind it.
  useEffect(() => {
    function resetAfterPrint() { setPrintingOrderId(null); }
    window.addEventListener("afterprint", resetAfterPrint);
    return () => window.removeEventListener("afterprint", resetAfterPrint);
  }, []);

  function printOrder(orderId) {
    setPrintingOrderId(orderId);
    requestAnimationFrame(() => window.print());
  }

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

  if (loading) return <OrdersSkeleton />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const sorted = sortByDate(orders, sortDirection);
  const onTheWay = sorted.filter((order) => ACTIVE_DELIVERY_STATUSES.has(order.delivery_status));
  const pastOrders = sorted.filter((order) => !ACTIVE_DELIVERY_STATUSES.has(order.delivery_status));
  const pastGroups = groupByMonth(pastOrders);

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-brand-700">Customer account</p>
          <h2 className="mt-1 font-serif text-3xl font-medium tracking-tight text-stone-900">Your orders</h2>
        </div>
        {orders.length > 1 && (
          <div className="flex items-center gap-1 rounded-full border border-stone-200 bg-white p-1 text-sm">
            <button
              onClick={() => setSortDirection("newest")}
              className={`rounded-full px-3 py-1.5 font-medium transition ${sortDirection === "newest" ? "bg-brand-100 text-brand-800" : "text-stone-500 hover:text-stone-800"}`}
            >
              Newest first
            </button>
            <button
              onClick={() => setSortDirection("oldest")}
              className={`rounded-full px-3 py-1.5 font-medium transition ${sortDirection === "oldest" ? "bg-brand-100 text-brand-800" : "text-stone-500 hover:text-stone-800"}`}
            >
              Oldest first
            </button>
          </div>
        )}
      </div>

      {showConfirmation && latestOrder && CONFIRMATION_STATUSES.has(latestOrder.status) && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 flex items-start justify-between gap-3 rounded-2xl border border-brand-200 bg-brand-50 p-4 text-sm text-brand-800"
        >
          <p>
            <strong>Order placed!</strong>{" "}
            {latestOrder.status === "PENDING_ON_DELIVERY"
              ? "Pay in cash when it arrives."
              : "Your payment was confirmed."}
          </p>
          <button onClick={() => setShowConfirmation(false)} className="shrink-0 font-medium text-brand-700 hover:text-brand-900">
            Dismiss
          </button>
        </motion.div>
      )}

      {orders.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-brand-300 bg-white p-12 text-center shadow-luxe-sm">
          <p className="text-stone-500">You have not placed an order yet.</p>
          <button
            onClick={() => onNavigate("catalogue")}
            className="mt-5 rounded-full bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white shadow-luxe-sm transition hover:-translate-y-0.5 hover:bg-brand-700 active:translate-y-0"
          >
            Browse the catalogue
          </button>
        </div>
      ) : (
        <div className="mt-6 space-y-10">
          {onTheWay.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">On the way</h3>
              <div className="mt-3 space-y-4">
                {onTheWay.map((order, index) => (
                  <OrderCard
                    key={order.order_id}
                    order={order}
                    index={index}
                    idToken={idToken}
                    printing={printingOrderId === order.order_id}
                    onPrint={() => printOrder(order.order_id)}
                  />
                ))}
              </div>
            </div>
          )}

          {pastGroups.map((group) => (
            <div key={group.label}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">{group.label}</h3>
              <div className="mt-3 space-y-4">
                {group.orders.map((order, index) => (
                  <OrderCard
                    key={order.order_id}
                    order={order}
                    index={index}
                    idToken={idToken}
                    printing={printingOrderId === order.order_id}
                    onPrint={() => printOrder(order.order_id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {cursor && (
        <div className="mt-6 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-full border border-brand-600 px-7 py-2.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}

export function OrderCard({ order, index = 0, idToken, printing, onPrint }) {
  const flagged = isWarningStatus(order.status);
  return (
    <motion.article
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 5) * 0.05, duration: 0.35, ease: "easeOut" }}
      className={`overflow-hidden rounded-2xl bg-white shadow-luxe-sm ${printing ? "print-receipt" : ""}`}
    >
      <div className={`flex ${flagged ? "border-l-4 border-amber-400" : ""}`}>
        <div className="min-w-0 flex-1 p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0"><p className="font-semibold text-stone-900">Order placed</p><p className="mt-1 text-sm text-stone-500">{new Date(order.created_at).toLocaleString()}</p></div>
            <StatusBadge status={order.status} />
          </div>
          <ul className="mt-4 space-y-2.5 border-y border-brand-900/10 py-4 text-sm text-stone-600">
            {order.items.map((item) => (
              <li key={item.product_id} className="flex items-center gap-3">
                <ItemThumbnail productId={item.product_id} idToken={idToken} />
                <span className="min-w-0 flex-1 truncate">{item.quantity} × {item.name}</span>
                <span className="tabular-nums shrink-0">{formatPrice(Number(item.unit_price) * item.quantity)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between font-semibold text-stone-900"><span>Total</span><span className="tabular-nums">{formatPrice(order.total)}</span></div>
          {order.payment_method && (
            <p className="mt-3 text-sm text-stone-500">
              {order.payment_method === "cash_on_delivery" ? "Cash on delivery" : "Paid by card"}
              {order.shipping_address && <> — delivering to {order.shipping_address.city}, {order.shipping_address.country}</>}
            </p>
          )}
          {order.delivery_status && <DeliveryStatus status={order.delivery_status} />}
          {order.failure_reason && <p className="mt-3 text-sm text-red-700">{order.failure_reason}</p>}

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-brand-900/10 pt-4 text-sm">
            <button onClick={onPrint} className="font-medium text-brand-700 transition hover:text-brand-900 print:hidden">
              Print receipt
            </button>
            <a
              href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Help with order ${order.order_id}`)}`}
              className="font-medium text-stone-500 transition hover:text-stone-800 print:hidden"
            >
              Need help with this order?
            </a>
          </div>
        </div>
      </div>
    </motion.article>
  );
}

function ItemThumbnail({ productId, idToken }) {
  // undefined while loading (renders the placeholder, same as a missing
  // image) — this never has its own image_url; a stored order snapshots
  // name/price at the time of purchase, not a picture, so this asks the
  // catalogue for the product's CURRENT image purely for display. If the
  // product's since been removed, the fetch just fails quietly and the
  // placeholder stays — no worse than an order with no thumbnail at all.
  const [imageUrl, setImageUrl] = useState(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchProductById(productId, idToken)
      .then((product) => { if (!cancelled) setImageUrl(product.image_url || null); })
      .catch(() => { if (!cancelled) setImageUrl(null); });
    return () => { cancelled = true; };
  }, [productId, idToken]);

  return <ProductImage src={imageUrl} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />;
}

export function isWarningStatus(status) {
  return String(status).includes("UNKNOWN") || String(status).includes("FAILED") || String(status).includes("REJECTED");
}

export function StatusBadge({ status }) {
  const warning = isWarningStatus(status);
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${warning ? "bg-amber-100 text-amber-800" : "bg-brand-100 text-brand-800"}`}>{status}</span>;
}

// Same order, same wording, as the DeliveryStatusChanged email
// (notification-service/app/emailer.py's _DELIVERY_STATUS_MESSAGES) — a
// customer reading the email and then checking this page should see the
// same language, not two different vocabularies for one thing.
const DELIVERY_STEPS = [
  { value: "PROCESSING", label: "Processing", icon: <><path d="M21 8l-9-5-9 5 9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></> },
  { value: "SHIPPED", label: "Shipped", icon: <><rect x="1" y="7" width="13" height="10" rx="1" /><path d="M14 10h4l3 3v4h-7z" /><circle cx="5.5" cy="19" r="1.5" /><circle cx="17.5" cy="19" r="1.5" /></> },
  { value: "OUT_FOR_DELIVERY", label: "Out for delivery", icon: <><path d="M12 21s-7-6.5-7-11a7 7 0 0 1 14 0c0 4.5-7 11-7 11Z" /><circle cx="12" cy="10" r="2.5" /></> },
  { value: "DELIVERED", label: "Delivered", icon: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 6-6" /></> },
];

function StepIcon({ icon, className }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {icon}
    </svg>
  );
}

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
      <ol className="mt-3 flex items-center gap-1.5">
        {DELIVERY_STEPS.map((step, index) => {
          const isCurrent = index === currentIndex;
          const isDone = index <= currentIndex;
          return (
            <li key={step.value} className="flex flex-1 items-center gap-1.5 last:flex-none">
              <span className={`flex flex-col items-center gap-1.5 ${isDone ? "text-brand-700" : "text-stone-300"}`}>
                <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50">
                  {isCurrent && (
                    <motion.span
                      className="absolute inset-0 rounded-full bg-brand-300"
                      animate={{ scale: [1, 1.5], opacity: [0.6, 0] }}
                      transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
                    />
                  )}
                  <StepIcon icon={step.icon} className={`relative h-4 w-4 ${isDone ? "text-brand-700" : "text-stone-300"}`} />
                </span>
                <span className="hidden text-xs font-medium sm:block">{step.label}</span>
              </span>
              {index < DELIVERY_STEPS.length - 1 && (
                <span className={`h-0.5 flex-1 ${index < currentIndex ? "bg-brand-600" : "bg-stone-200"}`} />
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-1.5 text-xs font-medium text-stone-600 sm:hidden">
        {DELIVERY_STEPS[currentIndex].label}
      </p>
    </div>
  );
}

function OrdersSkeleton() {
  return (
    <section aria-busy="true" aria-label="Loading your orders">
      <p className="text-sm font-medium text-brand-700">Customer account</p>
      <h2 className="mt-1 font-serif text-3xl font-medium tracking-tight text-stone-900">Your orders</h2>
      <div className="mt-6 space-y-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-2xl bg-white p-5 shadow-luxe-sm sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="h-4 w-32 overflow-hidden rounded bg-cream-200"><div className="h-full w-full animate-shimmer" /></div>
              <div className="h-5 w-20 overflow-hidden rounded-full bg-cream-200"><div className="h-full w-full animate-shimmer" /></div>
            </div>
            <div className="mt-4 space-y-2.5 border-y border-brand-900/10 py-4">
              <div className="h-10 w-full overflow-hidden rounded bg-cream-200"><div className="h-full w-full animate-shimmer" /></div>
              <div className="h-10 w-full overflow-hidden rounded bg-cream-200"><div className="h-full w-full animate-shimmer" /></div>
            </div>
            <div className="h-4 w-24 overflow-hidden rounded bg-cream-200"><div className="h-full w-full animate-shimmer" /></div>
          </div>
        ))}
      </div>
    </section>
  );
}
