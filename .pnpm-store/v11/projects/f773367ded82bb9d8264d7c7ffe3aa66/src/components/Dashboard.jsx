import { useCallback, useEffect, useState } from "react";
import { fetchAdminProducts } from "../api/products.js";
import { fetchAttentionOrders } from "../api/orders.js";
import { StatusBadge } from "./OrdersPage.jsx";
import ErrorState from "./ErrorState.jsx";
import LoadingState from "./LoadingState.jsx";

// Deliberately limited to data that's already free to fetch (no new backend
// endpoints): the admin product list and the existing "needs attention"
// order query. A "recent orders across all customers" or "low stock" tile
// would each need a new backend capability — there is no all-orders listing
// endpoint by design (ADR: avoiding a full-table Scan) and stock is only
// fetchable one product at a time today.
export default function Dashboard({ idToken, onNavigate }) {
  const [products, setProducts] = useState([]);
  const [attentionOrders, setAttentionOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchAdminProducts({ limit: 100, idToken }),
      fetchAttentionOrders(idToken),
    ])
      .then(([productPage, stuck]) => {
        setProducts(productPage.items || []);
        setAttentionOrders(stuck || []);
      })
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false));
  }, [idToken]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingState label="Loading dashboard…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const activeCount = products.filter((product) => product.active).length;
  const inactiveCount = products.length - activeCount;

  return (
    <section>
      <p className="text-sm font-medium text-brand-700">Administrator workspace</p>
      <h2 className="mt-1 text-3xl font-bold tracking-tight text-stone-900">Dashboard</h2>

      <div className="mt-7 grid gap-4 sm:grid-cols-3">
        <StatTile label="Active products" value={activeCount} />
        <StatTile label="Inactive products" value={inactiveCount} />
        <StatTile
          label="Orders needing attention"
          value={attentionOrders.length}
          tone={attentionOrders.length > 0 ? "warning" : "default"}
        />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-bold text-stone-900">Orders needing attention</h3>
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

        <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-bold text-stone-900">Catalogue</h3>
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

function StatTile({ label, value, tone = "default" }) {
  const toneClass = tone === "warning" && value > 0
    ? "border-amber-300 bg-amber-50 text-amber-900"
    : "border-stone-200 bg-white text-stone-900";
  return (
    <div className={`rounded-xl border p-5 shadow-sm ${toneClass}`}>
      <p className="text-3xl font-bold">{value}</p>
      <p className="mt-1 text-sm text-stone-600">{label}</p>
    </div>
  );
}
