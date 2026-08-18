import { useEffect, useState, useCallback } from "react";
import { fetchProductById } from "../api/products.js";
import { fetchStock } from "../api/inventory.js";
import ProductImage from "./ProductImage.jsx";
import LoadingState from "./LoadingState.jsx";
import ErrorState from "./ErrorState.jsx";
import { formatPrice } from "../lib/currency.js";
import { useWebSocketMessage } from "../realtime/WebSocketProvider.jsx";

export default function ProductDetail({ productId, onBack, onAddToCart, idToken }) {
  const [product, setProduct] = useState(null);
  const [stock, setStock] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchProductById(productId, idToken)
      .then(setProduct)
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
        <div className="grid grid-cols-1 gap-8 rounded-2xl border border-stone-200 bg-white p-6 shadow-sm md:grid-cols-2 md:p-8">
          <ProductImage src={product.image_url} alt={product.name} className="h-72 w-full rounded-xl object-cover md:h-full" />

          <div className="flex flex-col gap-3">
            <span className="w-fit rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700">
              {product.category}
            </span>
            <h1 className="text-2xl font-semibold text-stone-900">
              {product.name}
            </h1>
            <p className="text-2xl font-bold text-brand-700">
              {formatPrice(product.price)}
            </p>
            <p className="leading-relaxed text-stone-600">
              {product.description}
            </p>
            {stock && (
              <p className={`text-sm font-medium ${stock.available_quantity > 0 ? "text-stone-500" : "text-red-600"}`}>
                {stock.available_quantity > 0 ? `${stock.available_quantity} in stock` : "Out of stock"}
              </p>
            )}
            <button
              onClick={() => onAddToCart(product)}
              disabled={stock ? stock.available_quantity <= 0 : false}
              className="mt-4 w-fit rounded-md bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
            >
              Add to basket
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
