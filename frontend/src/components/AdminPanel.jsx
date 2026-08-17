import { useCallback, useEffect, useState } from "react";
import { createProduct, fetchAdminProducts, setProductActive, updateProduct } from "../api/products.js";
import { addStock, fetchStock } from "../api/inventory.js";
import { fetchAttentionOrders } from "../api/orders.js";
import { fetchPayment, refundPayment } from "../api/payments.js";
import { StatusBadge } from "./OrdersPage.jsx";
import ImagePlaceholder from "./ImagePlaceholder.jsx";
import { formatPrice } from "../lib/currency.js";

const blankProduct = { name: "", description: "", price: "", category: "", image_url: "" };

export default function AdminPanel({ idToken }) {
  const [products, setProducts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attentionOrders, setAttentionOrders] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [stock, setStock] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // null editingProduct + formOpen = creating a new product.
  // An object = editing that specific row. Acting on a row the admin can
  // already see means this never needs the full catalogue loaded, only
  // whatever page(s) are on screen right now.
  const [formOpen, setFormOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);

  // load() always resets back to the first page. A mutation (create, edit,
  // activate/deactivate) can move any product in or out of the current
  // filtered view, so re-fetching from the start is the only way to keep
  // what's on screen consistent with what a "Load more" click would build on.
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [productPage, stuck] = await Promise.all([
        fetchAdminProducts({ limit: 20, idToken }),
        fetchAttentionOrders(idToken),
      ]);
      setProducts(productPage.items || []);
      setCursor(productPage.next_cursor || null);
      setAttentionOrders(stuck || []);
    } catch (loadError) { setError(loadError.message); }
    finally { setLoading(false); }
  }, [idToken]);

  useEffect(() => { load(); }, [load]);

  async function loadMoreProducts() {
    setLoadingMore(true); setError(null);
    try {
      const productPage = await fetchAdminProducts({ limit: 20, cursor, idToken });
      setProducts((current) => [...current, ...(productPage.items || [])]);
      setCursor(productPage.next_cursor || null);
    } catch (loadError) { setError(loadError.message); }
    finally { setLoadingMore(false); }
  }

  async function showStock(product) {
    setSelectedProduct(product); setStock(null); setError(null);
    try { setStock(await fetchStock(product.id, idToken)); }
    catch (stockError) { setError(stockError.status === 404 ? "No inventory record exists yet; it will be created when you add stock." : stockError.message); }
  }

  async function changeActive(product) {
    setError(null);
    try {
      await setProductActive(product.id, !product.active, idToken);
      setMessage(`${product.name} is now ${product.active ? "inactive" : "active"}.`);
      load();
    } catch (actionError) { setError(actionError.message); }
  }

  function openCreate() { setEditingProduct(null); setFormOpen(true); }
  function openEdit(product) { setEditingProduct(product); setFormOpen(true); }
  function closeForm() { setFormOpen(false); setEditingProduct(null); }

  if (loading) return <p className="py-12 text-stone-500">Loading administrator workspace…</p>;
  return (
    <section>
      <p className="text-sm font-medium text-brand-700">Administrator workspace</p>
      <h2 className="mt-1 text-3xl font-bold tracking-tight text-stone-900">Catalogue and operations</h2>
      {message && <p className="mt-5 rounded-md bg-brand-50 p-3 text-sm text-brand-800">{message}</p>}
      {error && <p className="mt-5 rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
      <div className="mt-7 grid gap-8 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-8">
          {formOpen && (
            <ProductEditor
              idToken={idToken}
              product={editingProduct}
              onSaved={() => { setMessage("Product saved."); closeForm(); load(); }}
              onCancel={closeForm}
              onError={setError}
            />
          )}
          <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-bold text-stone-900">Product catalogue</h3>
              <button
                onClick={openCreate}
                className="rounded-md bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                Add product
              </button>
            </div>
            {products.length === 0 ? (
              <p className="mt-4 py-8 text-center text-sm text-stone-500">No products yet — use "Add product" to create the first one.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="border-b text-stone-500">
                    <tr>
                      <th className="pb-3 pr-3"></th>
                      <th className="pb-3">Product</th>
                      <th className="pb-3">Price</th>
                      <th className="pb-3">Status</th>
                      <th className="pb-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((product) => (
                      <tr key={product.id} className="border-b border-stone-100">
                        <td className="py-3 pr-3">
                          {product.image_url ? (
                            <img src={product.image_url} alt={product.name} className="h-12 w-12 rounded-md object-cover" />
                          ) : (
                            <ImagePlaceholder className="h-12 w-12 rounded-md" />
                          )}
                        </td>
                        <td className="py-3 font-medium text-stone-900">
                          {product.name}
                          <p className="font-normal text-stone-500">{product.category}</p>
                        </td>
                        <td className="py-3">{formatPrice(product.price)}</td>
                        <td className="py-3"><StatusBadge status={product.active ? "ACTIVE" : "INACTIVE"} /></td>
                        <td className="py-3">
                          <div className="flex gap-3">
                            <button onClick={() => openEdit(product)} className="font-medium text-brand-700 hover:text-brand-900">Edit</button>
                            <button onClick={() => showStock(product)} className="font-medium text-brand-700 hover:text-brand-900">Stock</button>
                            <button onClick={() => changeActive(product)} className="font-medium text-stone-700 hover:text-stone-900">{product.active ? "Deactivate" : "Activate"}</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {cursor && (
              <div className="mt-4 flex justify-center">
                <button
                  onClick={loadMoreProducts}
                  disabled={loadingMore}
                  className="rounded-md border border-brand-600 px-4 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Load more products"}
                </button>
              </div>
            )}
          </section>
        </div>
        <div className="space-y-8">
          <StockPanel product={selectedProduct} stock={stock} idToken={idToken} onUpdated={showStock} onMessage={setMessage} onError={setError} />
          <AttentionOrders orders={attentionOrders} idToken={idToken} onError={setError} onMessage={setMessage} />
        </div>
      </div>
    </section>
  );
}

function ProductEditor({ idToken, product, onSaved, onCancel, onError }) {
  const [form, setForm] = useState(() => product ? { ...product, image_url: product.image_url || "" } : blankProduct);
  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  async function submit(event) {
    event.preventDefault(); onError(null);
    const payload = { ...form, price: String(form.price), image_url: form.image_url || null };
    try {
      if (product) await updateProduct(product.id, payload, idToken);
      else await createProduct(payload, idToken);
      onSaved();
    } catch (saveError) { onError(saveError.message); }
  }
  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-bold text-stone-900">{product ? `Edit ${product.name}` : "Add product"}</h3>
        <button onClick={onCancel} className="text-sm font-medium text-stone-500 hover:text-stone-700">Cancel</button>
      </div>
      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
        {[["name", "Name"], ["category", "Category"], ["price", "Price"]].map(([field, label]) => (
          <label key={field} className="text-sm font-medium text-stone-700">
            {label}
            <input
              type={field === "price" ? "number" : "text"}
              min={field === "price" ? "0.01" : undefined}
              step={field === "price" ? "0.01" : undefined}
              value={form[field]}
              onChange={(event) => update(field, event.target.value)}
              required
              className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
            />
          </label>
        ))}
        <label className="text-sm font-medium text-stone-700">
          Image URL
          <div className="mt-1 flex items-center gap-3">
            {form.image_url ? (
              <img src={form.image_url} alt="" className="h-11 w-11 shrink-0 rounded-md object-cover" />
            ) : (
              <ImagePlaceholder className="h-11 w-11 shrink-0 rounded-md" />
            )}
            <input
              type="text"
              value={form.image_url}
              onChange={(event) => update("image_url", event.target.value)}
              placeholder="https://…"
              className="w-full rounded-md border border-stone-300 px-3 py-2"
            />
          </div>
        </label>
        <label className="sm:col-span-2 text-sm font-medium text-stone-700">
          Description
          <textarea
            value={form.description}
            onChange={(event) => update("description", event.target.value)}
            required
            rows="3"
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </label>
        <button className="w-fit rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
          {product ? "Save product" : "Create product"}
        </button>
      </form>
    </section>
  );
}

function StockPanel({ product, stock, idToken, onUpdated, onMessage, onError }) {
  const [quantity, setQuantity] = useState(1);
  if (!product) return <section className="rounded-xl border border-dashed border-stone-300 bg-white p-5 text-sm text-stone-500">Choose <strong>Stock</strong> beside a product to view or restock it.</section>;
  async function restock(event) { event.preventDefault(); onError(null); try { await addStock(product.id, quantity, idToken); onMessage(`Added ${quantity} units to ${product.name}.`); onUpdated(product); } catch (actionError) { onError(actionError.message); } }
  return <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm"><h3 className="text-lg font-bold text-stone-900">Stock: {product.name}</h3>{stock ? <p className="mt-3 text-sm text-stone-600"><strong>{stock.available_quantity}</strong> available · <strong>{stock.reserved_quantity}</strong> reserved</p> : <p className="mt-3 text-sm text-stone-500">No current stock record.</p>}<form onSubmit={restock} className="mt-4 flex gap-2"><label className="sr-only" htmlFor="stock-quantity">Units to add</label><input id="stock-quantity" type="number" min="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} className="w-24 rounded-md border border-stone-300 px-3 py-2" /><button className="rounded-md bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700">Add stock</button></form></section>;
}

function AttentionOrders({ orders, idToken, onError, onMessage }) {
  const [payment, setPayment] = useState(null);
  async function inspectPayment(order) { if (!order.payment_id) return; onError(null); try { setPayment(await fetchPayment(order.payment_id, idToken)); } catch (lookupError) { onError(lookupError.message); } }
  async function refund() { if (!payment) return; onError(null); try { const result = await refundPayment(payment.payment_id, idToken); setPayment(result); onMessage(`Refund result: ${result.status}.`); } catch (refundError) { onError(refundError.message); } }
  return <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm"><h3 className="text-lg font-bold text-stone-900">Orders needing attention</h3>{orders.length === 0 ? <p className="mt-3 text-sm text-stone-500">No orders currently need reconciliation.</p> : <ul className="mt-3 space-y-3">{orders.map((order) => <li key={order.order_id} className="rounded-md bg-stone-50 p-3 text-sm"><div className="flex justify-between gap-2"><span className="min-w-0 break-all font-medium">{order.order_id}</span><span className="shrink-0"><StatusBadge status={order.status} /></span></div>{order.payment_id && <button onClick={() => inspectPayment(order)} className="mt-2 font-medium text-brand-700">Inspect payment</button>}</li>)}</ul>}{payment && <div className="mt-4 rounded-md bg-brand-50 p-3 text-sm"><p><strong>Payment:</strong> {payment.status}</p><p className="mt-1 text-stone-600">{payment.payment_id}</p>{payment.status === "SUCCEEDED" && <button onClick={refund} className="mt-3 font-medium text-brand-700">Issue refund</button>}</div>}</section>;
}
