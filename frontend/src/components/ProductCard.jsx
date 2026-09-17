import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import ProductImage from "./ProductImage.jsx";
import { formatPrice } from "../lib/currency.js";
import { fetchStock } from "../api/inventory.js";
import { useWebSocketMessage } from "../realtime/WebSocketProvider.jsx";

export default function ProductCard({ product, onSelect, onAddToCart, idToken }) {
  // The numeric level is what onAddToCart needs to enforce a real stock cap
  // (App.jsx's addToCart); outOfStock below is just this derived to a
  // boolean for the disabled/badge styling.
  const [availableQuantity, setAvailableQuantity] = useState(null);
  const outOfStock = availableQuantity !== null && availableQuantity <= 0;

  useEffect(() => {
    let cancelled = false;
    fetchStock(product.id, idToken)
      .then((stock) => {
        if (!cancelled) setAvailableQuantity(stock.available_quantity);
      })
      .catch((err) => {
        // A 404 means no inventory record exists for this product at all —
        // nothing to sell, treated the same as zero available. Any other
        // failure (network, 500) is left alone rather than guessing "out of
        // stock" from what might just be a transient error.
        if (!cancelled && err.status === 404) setAvailableQuantity(0);
      });
    return () => { cancelled = true; };
  }, [product.id, idToken]);

  // A live top-up on the fetch above, not a replacement for it — the
  // WebSocket only reports CHANGES from the moment it connects, never the
  // level that was already true beforehand.
  const handleStockUpdate = useCallback((message) => {
    if (message.product_id !== product.id) return;
    setAvailableQuantity(message.available);
  }, [product.id]);
  useWebSocketMessage("StockUpdated", handleStockUpdate);

  function handleAddToCart(event) {
    // Stops this reaching the card's own onClick below — without it, adding
    // to cart would ALSO open the product detail view.
    event.stopPropagation();
    onAddToCart(product, availableQuantity);
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(product.id);
    }
  }

  return (
    <motion.article
      onClick={() => onSelect(product.id)}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      whileHover={{ y: -5 }}
      transition={{ type: "spring", stiffness: 400, damping: 26 }}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-2xl bg-white text-left shadow-luxe-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
    >
      <motion.div
        layoutId={`product-image-${product.id}`}
        transition={{ layout: { type: "spring", stiffness: 300, damping: 32 } }}
        className="relative overflow-hidden"
      >
        <ProductImage
          src={product.image_url}
          alt={product.name}
          className="h-48 w-full object-cover transition duration-500 ease-out group-hover:scale-[1.04]"
        />
        {outOfStock && (
          <span className="absolute left-3 top-3 rounded-full bg-persimmon-600 px-2.5 py-1 text-xs font-semibold text-white">
            Out of stock
          </span>
        )}
      </motion.div>

      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <span className="w-fit rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
          {product.category}
        </span>
        <h3 className="font-serif text-base font-semibold text-stone-900 transition group-hover:text-brand-700">
          {product.name}
        </h3>
        <p className="line-clamp-2 text-sm text-stone-500">
          {product.description}
        </p>
        <div className="mt-auto flex items-end justify-between gap-2 pt-3">
          <div>
            <p className="tabular-nums text-lg font-semibold text-stone-900">
              {formatPrice(product.price)}
            </p>
            {outOfStock && (
              <p className="text-xs font-semibold text-persimmon-600">Out of stock</p>
            )}
          </div>
          <button
            onClick={handleAddToCart}
            onKeyDown={(event) => event.stopPropagation()}
            disabled={outOfStock}
            className="rounded-full bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 active:scale-95 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400 disabled:active:scale-100"
          >
            Add
          </button>
        </div>
      </div>
    </motion.article>
  );
}
