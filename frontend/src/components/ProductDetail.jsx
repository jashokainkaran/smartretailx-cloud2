import { useEffect, useState, useCallback } from "react";
import { fetchProductById } from "../api/products.js";
import ImagePlaceholder from "./ImagePlaceholder.jsx";
import LoadingState from "./LoadingState.jsx";
import ErrorState from "./ErrorState.jsx";
import { formatPrice } from "../lib/currency.js";

export default function ProductDetail({ productId, onBack }) {
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchProductById(productId)
      .then(setProduct)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [productId]);

  useEffect(() => {
    load();
  }, [load]);

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
          {product.image_url ? (
            <img
              src={product.image_url}
              alt={product.name}
              className="h-72 w-full rounded-xl object-cover md:h-full"
            />
          ) : (
            <ImagePlaceholder className="h-72 w-full rounded-xl md:h-full" />
          )}

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
          </div>
        </div>
      )}
    </div>
  );
}
