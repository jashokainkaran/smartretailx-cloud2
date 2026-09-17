import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { fetchProductById } from "../api/products.js";
import { fetchStock } from "../api/inventory.js";
import ProductImage from "./ProductImage.jsx";
import LoadingState from "./LoadingState.jsx";
import ErrorState from "./ErrorState.jsx";
import { formatPrice } from "../lib/currency.js";
import { useWebSocketMessage } from "../realtime/WebSocketProvider.jsx";
import { recordProductView } from "../lib/recentlyViewed.js";

export default function ProductDetail({ productId, onBack, onAddToCart, idToken }) {
  const [product, setProduct] = useState(null);
  const [stock, setStock] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [zoomOrigin, setZoomOrigin] = useState("50% 50%");
  const [tapZoomed, setTapZoomed] = useState(false);
  // Desktop gets a cursor-following magnify (mousemove has something
  // meaningful to react to); a touchscreen has no hover to hook the zoom
  // to, so it gets a plain tap-to-zoom toggle instead — two different
  // interactions for the same "let me see this closer" need, not one
  // half-working compromise for both.
  const [supportsHover] = useState(() => {
    try { return Boolean(window.matchMedia?.("(hover: hover)").matches); }
    catch { return false; }
  });

  function handleImageMouseMove(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    setZoomOrigin(`${x}% ${y}%`);
  }

  // Navigating straight from one product's detail page to another's (via
  // "you might also like"-style links, if any land here later) shouldn't
  // carry a tap-zoomed state over onto a different product's photo.
  useEffect(() => {
    setTapZoomed(false);
    setZoomOrigin("50% 50%");
  }, [productId]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchProductById(productId, idToken)
      .then((loaded) => { setProduct(loaded); recordProductView(loaded); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [productId, idToken]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    setStock(null);
    fetchStock(productId, idToken)
      .then((result) => { if (!cancelled) setStock(result); })
      .catch((err) => {
        // A 404 means no inventory record exists — treated as zero
        // available, same as ProductCard. Other failures are left alone.
        if (!cancelled && err.status === 404) setStock({ available_quantity: 0 });
      });
    return () => { cancelled = true; };
  }, [productId, idToken]);

  // A live top-up on the fetch above, not a replacement for it — see
  // ProductCard's own version of this for the full reasoning.
  const handleStockUpdate = useCallback((message) => {
    if (message.product_id !== productId) return;
    setStock({ available_quantity: message.available });
  }, [productId]);
  useWebSocketMessage("StockUpdated", handleStockUpdate);

  return (
    <div>
      <button
        onClick={onBack}
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-stone-500 transition hover:text-brand-700"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-4 w-4"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
        Back to products
      </button>

      {loading && <LoadingState label="Loading product…" />}
      {error && <ErrorState message={error} onRetry={load} />}

      {product && !loading && !error && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="grid grid-cols-1 gap-6 rounded-3xl bg-white p-6 shadow-luxe md:grid-cols-2 md:gap-10 md:p-10"
        >
          <motion.div
            layoutId={`product-image-${product.id}`}
            transition={{ layout: { type: "spring", stiffness: 300, damping: 32 } }}
            className="group relative overflow-hidden rounded-2xl bg-cream-200"
          >
            <div
              onMouseMove={supportsHover ? handleImageMouseMove : undefined}
              onClick={!supportsHover ? () => setTapZoomed((current) => !current) : undefined}
              style={supportsHover ? { transformOrigin: zoomOrigin } : undefined}
              className={`h-72 w-full transition-transform duration-300 ease-out md:h-full ${
                supportsHover ? "cursor-zoom-in group-hover:scale-[1.7]" : `cursor-pointer ${tapZoomed ? "scale-150" : ""}`
              }`}
            >
              <ProductImage src={product.image_url} alt={product.name} className="h-full w-full object-cover" />
            </div>
            {!supportsHover && (
              <span className="pointer-events-none absolute bottom-3 right-3 rounded-full bg-white/90 px-2.5 py-1 text-xs font-medium text-stone-600 shadow-sm">
                {tapZoomed ? "Tap to shrink" : "Tap to zoom"}
              </span>
            )}
          </motion.div>

          <div className="flex flex-col gap-3">
            <span className="w-fit rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700">
              {product.category}
            </span>
            <h1 className="font-serif text-3xl font-medium text-stone-900">
              {product.name}
            </h1>
            <p className="tabular-nums text-2xl font-semibold text-brand-700">
              {formatPrice(product.price)}
            </p>
            <p className="leading-relaxed text-stone-600">
              {product.description}
            </p>
            {stock && (
              <p className={`text-sm font-medium ${stock.available_quantity > 0 ? "text-stone-500" : "text-persimmon-600"}`}>
                {stock.available_quantity > 0 ? `${stock.available_quantity} in stock` : "Out of stock"}
              </p>
            )}
            <button
              onClick={() => onAddToCart(product, stock?.available_quantity)}
              disabled={stock ? stock.available_quantity <= 0 : false}
              className="mt-4 w-fit rounded-full bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-luxe-sm transition hover:-translate-y-0.5 hover:bg-brand-700 active:translate-y-0 disabled:cursor-not-allowed disabled:translate-y-0 disabled:bg-stone-200 disabled:text-stone-400 disabled:shadow-none"
            >
              Add to basket
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}
