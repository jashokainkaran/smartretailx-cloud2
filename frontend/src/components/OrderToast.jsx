import { StatusBadge } from "./OrdersPage.jsx";

const PAYMENT_METHOD_LABELS = {
  card: "Card",
  cash_on_delivery: "Cash on delivery",
};

// Stacked, not a single slot like the generic Toast — orders can resolve in
// close succession (a burst of checkouts), and each one is admin-relevant
// enough that dropping an earlier toast to show a later one would lose
// information a person watching the dashboard actually wants.
export default function OrderToast({ toasts }) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed right-4 top-20 z-20 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.key}
          role="status"
          aria-live="polite"
          className="animate-toast-in rounded-lg border border-stone-200 bg-white p-3 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold text-stone-900">
              {toast.order_id}
            </span>
            {toast.type === "OrderNeedsReconciliation" ? (
              <span className="shrink-0 rounded-full bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-800">
                Needs reconciliation
              </span>
            ) : (
              <span className="shrink-0"><StatusBadge status={toast.status} /></span>
            )}
          </div>
          {toast.type === "OrderNeedsReconciliation" ? (
            <p className="mt-1 text-xs text-stone-600">{toast.reason}</p>
          ) : (
            <p className="mt-1 text-xs text-stone-500">
              {PAYMENT_METHOD_LABELS[toast.payment_method] || toast.payment_method}
              {toast.reason && ` — ${toast.reason}`}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
