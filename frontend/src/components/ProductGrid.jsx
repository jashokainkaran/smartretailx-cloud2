import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { fetchProducts } from "../api/products.js";
import ProductCard from "./ProductCard.jsx";
import ProductGridSkeleton from "./ProductGridSkeleton.jsx";
import ErrorState from "./ErrorState.jsx";

const gridVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" } },
};

export default function ProductGrid({ onSelectProduct, onAddToCart, idToken }) {
  const [products, setProducts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);

  const loadFirstPage = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchProducts({ limit: 12, idToken })
      .then((data) => {
        setProducts(data.items);
        setCursor(data.next_cursor);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [idToken]);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  function loadMore() {
    setLoadingMore(true);
    fetchProducts({ limit: 12, cursor, idToken })
      .then((data) => {
        setProducts((prev) => [...prev, ...data.items]);
        setCursor(data.next_cursor);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoadingMore(false));
  }

  return (
    <div>
      <p className="text-sm font-semibold uppercase tracking-[0.25em] text-brand-600">Catalogue</p>
      <h2 className="mt-1 font-serif text-3xl font-medium text-stone-900">Every piece, in stock</h2>

      {loading ? (
        <div className="mt-8"><ProductGridSkeleton /></div>
      ) : error ? (
        <div className="mt-8"><ErrorState message={error} onRetry={loadFirstPage} /></div>
      ) : products.length === 0 ? (
        <div className="mt-8 py-24 text-center text-stone-500">No products found.</div>
      ) : (
        <motion.div
          initial="hidden"
          animate="visible"
          variants={gridVariants}
          className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {products.map((product) => (
            <motion.div key={product.id} variants={cardVariants}>
              <ProductCard
                product={product}
                onSelect={onSelectProduct}
                onAddToCart={onAddToCart}
                idToken={idToken}
              />
            </motion.div>
          ))}
        </motion.div>
      )}

      {!loading && !error && cursor && (
        <div className="mt-10 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-full border border-brand-600 px-7 py-2.5 text-sm font-medium text-brand-700 transition hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
