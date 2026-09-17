import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { createProduct, fetchAdminProducts, setProductActive, updateProduct, uploadProductImage } from "../api/products.js";
import { addStock, fetchStock, fetchStockBatch } from "../api/inventory.js";
import { StatusBadge } from "./OrdersPage.jsx";
import ProductImage from "./ProductImage.jsx";
import Modal from "./Modal.jsx";
import SuccessNotice from "./SuccessNotice.jsx";
import { formatPrice } from "../lib/currency.js";

const blankProduct = { name: "", description: "", price: "", category: "", image_url: "" };
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function indexStockLevels(products, stockItems) {
  const levels = Object.fromEntries(products.map((product) => [product.id, 0]));
  stockItems.forEach((item) => { levels[item.product_id] = item.available_quantity; });
  return levels;
}

function CatalogueIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M21 8 12 3 3 8l9 5 9-5Z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
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

export default function AdminPanel({ idToken }) {
  const [products, setProducts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [stockByProductId, setStockByProductId] = useState({});
  const [loadingMore, setLoadingMore] = useState(false);
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
  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [search, setSearch] = useState("");

  // load() always resets back to the first page. Product creation and edits
  // can affect ordering, so those operations re-fetch from the beginning.
  // Activation changes update their one row locally and do not remount the
  // table or re-read every stock level.
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const productPage = await fetchAdminProducts({ limit: 20, idToken });
      const items = productPage.items || [];
      const stockItems = await fetchStockBatch(items.map((product) => product.id), idToken);
      setProducts(items);
      setStockByProductId(indexStockLevels(items, stockItems));
      setCursor(productPage.next_cursor || null);
    } catch (loadError) { setError(loadError.message); }
    finally { setLoading(false); }
  }, [idToken]);

  useEffect(() => { load(); }, [load]);

  // Existing categories from whatever's loaded, offered as autocomplete
  // suggestions in the product form — keeps naming consistent (no "Home
  // Goods" next to "home goods") without hard-coding a fixed list an admin
  // can never extend.
  const categoryOptions = useMemo(
    () => [...new Set(products.map((product) => product.category).filter(Boolean))].sort(),
    [products]
  );

  // Searches only what's already loaded rather than a dedicated backend
  // query — "Load more" already builds up the working set in memory, and
  // filtering that client-side is simpler than adding a search endpoint
  // this table otherwise doesn't need.
  const visibleProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return products;
    return products.filter((product) => product.name.toLowerCase().includes(query));
  }, [products, search]);

  async function loadMoreProducts() {
    setLoadingMore(true); setError(null);
    try {
      const productPage = await fetchAdminProducts({ limit: 20, cursor, idToken });
      const items = productPage.items || [];
      const stockItems = await fetchStockBatch(items.map((product) => product.id), idToken);
      setProducts((current) => [...current, ...items]);
      setStockByProductId((current) => ({ ...current, ...indexStockLevels(items, stockItems) }));
      setCursor(productPage.next_cursor || null);
    } catch (loadError) { setError(loadError.message); }
    finally { setLoadingMore(false); }
  }

  async function showStock(product) {
    setSelectedProduct(product); setStock(null); setError(null);
    try {
      const currentStock = await fetchStock(product.id, idToken);
      setStock(currentStock);
      setStockByProductId((current) => ({ ...current, [product.id]: currentStock.available_quantity }));
    }
    catch (stockError) { setError(stockError.status === 404 ? "No inventory record exists yet; it will be created when you add stock." : stockError.message); }
  }

  function closeStock() { setSelectedProduct(null); setStock(null); }

  async function changeActive(product) {
    setError(null);
    try {
      const updated = await setProductActive(product.id, !product.active, idToken);
      setProducts((current) => current.map((item) => item.id === updated.id ? updated : item));
      setMessage(`${updated.name} is now ${updated.active ? "active" : "inactive"}.`);
    } catch (actionError) { setError(actionError.message); }
  }

  async function confirmDeactivate() {
    if (!deactivateTarget) return;
    await changeActive(deactivateTarget);
    setDeactivateTarget(null);
  }

  function openCreate() { setEditingProduct(null); setFormOpen(true); }
  function openEdit(product) { setEditingProduct(product); setFormOpen(true); }
  function closeForm() { setFormOpen(false); setEditingProduct(null); }

  if (loading) return <p className="py-12 text-stone-500">Loading administrator workspace…</p>;
  return (
    <section>
      <p className="text-sm font-medium text-brand-700">Administrator workspace</p>
      <h2 className="mt-1 font-serif text-2xl font-semibold tracking-tight text-stone-900 sm:text-3xl">Catalogue and operations</h2>
      {message && <SuccessNotice className="mt-5">{message}</SuccessNotice>}
      {error && <p className="mt-5 rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
      {formOpen && (
        <Modal title={editingProduct ? `Edit ${editingProduct.name}` : "Add product"} onClose={closeForm}>
          <ProductEditor
            idToken={idToken}
            product={editingProduct}
            categoryOptions={categoryOptions}
            onSaved={() => { setMessage("Product saved."); closeForm(); load(); }}
            onCancel={closeForm}
            onError={setError}
          />
        </Modal>
      )}

      {/* Deactivating hides a product from the storefront — reversible, but
          worth an explicit confirm since it's one click on a dense table
          row, easy to fire by mistake next to Edit/Stock. Activating back
          is the "undo" direction, so it stays a single click. */}
      <AlertDialog.Root open={Boolean(deactivateTarget)} onOpenChange={(open) => !open && setDeactivateTarget(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-30 bg-plum/60 backdrop-blur-sm" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-40 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-luxe focus:outline-none">
            <AlertDialog.Title className="font-serif text-lg font-semibold text-stone-900">
              Deactivate {deactivateTarget?.name}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-stone-600">
              This removes it from the storefront immediately. You can reactivate it any time from this same table.
            </AlertDialog.Description>
            <div className="mt-5 flex gap-3">
              <button onClick={confirmDeactivate} className="rounded-full bg-stone-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-stone-900">
                Deactivate
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

      {selectedProduct && (
        <Modal title={`Stock: ${selectedProduct.name}`} onClose={closeStock}>
          <StockPanel product={selectedProduct} stock={stock} idToken={idToken} onUpdated={showStock} onMessage={setMessage} onError={setError} onClose={closeStock} />
        </Modal>
      )}

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: "easeOut" }} className="mt-7">
        <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h3 className="flex items-start gap-2 text-lg font-bold text-stone-900">
              <span className="mt-0.5 shrink-0"><CatalogueIcon /></span> Product catalogue
            </h3>
            <button
              onClick={openCreate}
              className="rounded-md bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Add product
            </button>
          </div>
          {products.length > 0 && (
            <div className="relative mt-4">
              <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search products by name…"
                aria-label="Search products by name"
                className="w-full rounded-md border border-stone-300 py-2 pl-9 pr-3 text-sm focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
            </div>
          )}
          {products.length === 0 ? (
            <p className="mt-4 py-8 text-center text-sm text-stone-500">No products yet — use "Add product" to create the first one.</p>
          ) : visibleProducts.length === 0 ? (
            <p className="mt-4 py-8 text-center text-sm text-stone-500">No products match "{search}".</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b text-stone-500">
                  <tr>
                    <th className="pb-3 pr-3"></th>
                    <th className="pb-3">Product</th>
                    <th className="pb-3">Price</th>
                    <th className="pb-3">Stock</th>
                    <th className="pb-3">Status</th>
                    <th className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleProducts.map((product) => (
                    <tr key={product.id} className="border-b border-stone-100 transition hover:bg-stone-50">
                      <td className="py-3 pr-3">
                        {/* h-12 w-12 on the wrapper, not the img — inside a
                            table cell, table auto-layout can collapse a
                            directly-sized <img> to zero width on a narrow
                            viewport before it settles on column widths. */}
                        <div className="h-12 w-12 overflow-hidden rounded-md">
                          <ProductImage src={product.image_url} alt={product.name} className="h-full w-full object-cover" />
                        </div>
                      </td>
                      <td className="py-3 font-medium text-stone-900">
                        {product.name}
                        <p className="font-normal text-stone-500">{product.category}</p>
                      </td>
                      <td className="py-3">{formatPrice(product.price)}</td>
                      <td className="py-3"><StockCell available={stockByProductId[product.id]} /></td>
                      <td className="py-3"><StatusBadge status={product.active ? "ACTIVE" : "INACTIVE"} /></td>
                      <td className="py-3">
                        <div className="flex gap-3">
                          <button onClick={() => openEdit(product)} className="font-medium text-brand-700 hover:text-brand-900">Edit</button>
                          <button onClick={() => showStock(product)} className="font-medium text-brand-700 hover:text-brand-900">Stock</button>
                          <button
                            onClick={() => (product.active ? setDeactivateTarget(product) : changeActive(product))}
                            className="font-medium text-stone-700 hover:text-stone-900"
                          >
                            {product.active ? "Deactivate" : "Activate"}
                          </button>
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
      </motion.div>
    </section>
  );
}

function ProductEditor({ idToken, product, categoryOptions, onSaved, onCancel, onError }) {
  const [form, setForm] = useState(() => product ? { ...product, image_url: product.image_url || "" } : blankProduct);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  async function handleImageFile(event) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file after an error
    if (!file) return;
    onError(null);
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      onError("Please choose a JPEG, PNG, or WebP image.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      onError("Image must be 5MB or smaller.");
      return;
    }
    setUploading(true);
    try {
      const imageUrl = await uploadProductImage(file, idToken);
      update("image_url", imageUrl);
    } catch (uploadError) { onError(uploadError.message); }
    finally { setUploading(false); }
  }

  async function submit(event) {
    event.preventDefault();
    if (submittingRef.current || uploading) return;
    onError(null);
    submittingRef.current = true;
    setSubmitting(true);
    // The datalist only suggests — it doesn't stop a slightly different
    // spelling being typed. A case/whitespace-only difference from an
    // existing category is snapped to that category's exact spelling, so
    // "home goods" and "Home Goods" don't end up as two categories; a
    // genuinely new category (no close match) still goes through as typed.
    const typedCategory = form.category.trim();
    const matchedCategory = categoryOptions.find((option) => option.toLowerCase() === typedCategory.toLowerCase());
    const payload = { ...form, category: matchedCategory || typedCategory, price: String(form.price), image_url: form.image_url || null };
    try {
      if (product) await updateProduct(product.id, payload, idToken);
      else await createProduct(payload, idToken);
      onSaved();
    } catch (saveError) { onError(saveError.message); }
    finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }
  return (
    <section className="p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-serif text-lg font-semibold text-stone-900">{product ? `Edit ${product.name}` : "Add product"}</h3>
        <button onClick={onCancel} className="text-sm font-medium text-stone-500 hover:text-stone-700">Cancel</button>
      </div>
      <form onSubmit={submit} aria-busy={submitting} className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-stone-700">
          Name
          <input
            type="text"
            value={form.name}
            onChange={(event) => update("name", event.target.value)}
            required
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </label>
        <label className="text-sm font-medium text-stone-700">
          Category
          <input
            type="text"
            list="admin-category-options"
            value={form.category}
            onChange={(event) => update("category", event.target.value)}
            required
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
          />
          <datalist id="admin-category-options">
            {categoryOptions.map((category) => <option key={category} value={category} />)}
          </datalist>
        </label>
        <label className="text-sm font-medium text-stone-700">
          Price
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={form.price}
            onChange={(event) => update("price", event.target.value)}
            required
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2"
          />
        </label>
        <label className="text-sm font-medium text-stone-700">
          Image
          <div className="mt-1 flex items-center gap-3">
            <ProductImage src={form.image_url} className="h-11 w-11 shrink-0 rounded-md object-cover" />
            <div className="flex w-full flex-col gap-2">
              <input
                type="file"
                accept={ALLOWED_IMAGE_TYPES.join(",")}
                onChange={handleImageFile}
                disabled={uploading || submitting}
                className="w-full text-sm text-stone-700 file:mr-3 file:rounded-md file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-brand-700 hover:file:bg-brand-100 disabled:cursor-not-allowed disabled:opacity-50"
              />
              {uploading && (
                <p className="flex items-center gap-1.5 text-xs text-stone-500">
                  <svg className="h-3.5 w-3.5 animate-spin text-brand-600" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
                    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  Uploading…
                </p>
              )}
            </div>
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
        <button
          type="submit"
          disabled={uploading || submitting}
          className="w-fit rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Saving…" : product ? "Save product" : "Create product"}
        </button>
      </form>
    </section>
  );
}

function StockCell({ available }) {
  if (available === undefined) return <span className="text-stone-400">—</span>;
  return (
    <span className={available <= 0 ? "font-medium text-persimmon-600" : "text-stone-700"}>
      {available}
    </span>
  );
}

function StockPanel({ product, stock, idToken, onUpdated, onMessage, onError, onClose }) {
  const [quantity, setQuantity] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  async function restock(event) {
    event.preventDefault();
    if (submittingRef.current) return;
    onError(null);
    submittingRef.current = true;
    setSubmitting(true);
    try { await addStock(product.id, quantity, idToken); onMessage(`Added ${quantity} units to ${product.name}.`); await onUpdated(product); }
    catch (actionError) { onError(actionError.message); }
    finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }
  return (
    <section className="p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-serif text-lg font-semibold text-stone-900">Stock: {product.name}</h3>
        <button onClick={onClose} className="text-sm font-medium text-stone-500 hover:text-stone-700">Close</button>
      </div>
      {stock ? (
        <p className="mt-4 text-sm text-stone-600"><strong>{stock.available_quantity}</strong> available · <strong>{stock.reserved_quantity}</strong> reserved</p>
      ) : (
        <p className="mt-4 text-sm text-stone-500">No current stock record.</p>
      )}
      <form onSubmit={restock} aria-busy={submitting} className="mt-4 flex gap-2">
        <label className="sr-only" htmlFor="stock-quantity">Units to add</label>
        <input id="stock-quantity" type="number" min="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={submitting} className="w-24 rounded-md border border-stone-300 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-60" />
        <button type="submit" disabled={submitting} className="rounded-md bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60">
          {submitting ? "Adding…" : "Add stock"}
        </button>
      </form>
    </section>
  );
}
