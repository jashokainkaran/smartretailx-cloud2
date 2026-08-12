import { useEffect, useState, useCallback } from "react";
import { fetchProducts } from "../api/products.js";
import ProductCard from "./ProductCard.jsx";
import LoadingState from "./LoadingState.jsx";
import ErrorState from "./ErrorState.jsx";

export default function ProductGrid({ onSelectProduct }) {
  const [products, setProducts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const loadFirstPage = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchProducts({ limit: 12 })
      .then((data) => {
        setProducts(data.items);
        setCursor(data.next_cursor);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  function loadMore() {
    setLoadingMore(true);
    fetchProducts({ limit: 12, cursor })
      .then((data) => {
        setProducts((prev) => [...prev, ...data.items]);
        setCursor(data.next_cursor);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoadingMore(false));
  }

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} onRetry={loadFirstPage} />;

  if (products.length === 0) {
    return (
      <div className="py-24 text-center text-stone-500">
        No products found.
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {products.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            onSelect={onSelectProduct}
          />
        ))}
      </div>

      {cursor && (
        <div className="mt-10 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-lg border border-brand-600 px-6 py-2.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
