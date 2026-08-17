import { useEffect, useState } from "react";
import ImagePlaceholder from "./ImagePlaceholder.jsx";
import { formatPrice } from "../lib/currency.js";
import { fetchStock } from "../api/inventory.js";

export default function ProductCard({ product, onSelect, onAddToCart, idToken }) {
  const [outOfStock, setOutOfStock] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchStock(product.id, idToken)
      .then((stock) => {
        if (!cancelled) setOutOfStock(stock.available_quantity <= 0);
      })
      .catch((err) => {
        // A 404 means no inventory record exists for this product at all —
        // nothing to sell, treated the same as zero available. Any other
        // failure (network, 500) is left alone rather than guessing "out of
        // stock" from what might just be a transient error.
        if (!cancelled && err.status === 404) setOutOfStock(true);
      });
    return () => { cancelled = true; };
  }, [product.id, idToken]);

  function handleAddToCart(event) {
    // Stops this reaching the card's own onClick below — without it, adding
    // to cart would ALSO open the product detail view.
    event.stopPropagation();
    onAddToCart(product);
  }

  function handleKeyDown(event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(product.id);
    }
  }

  return (
    <article
      onClick={() => onSelect(product.id)}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      className="group flex cursor-pointer flex-col overflow-hidden rounded-xl border border-stone-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-400"
    >
      <div className="relative">
        {product.image_url ? (
          <img
            src={product.image_url}
            alt={product.name}
            className="h-44 w-full object-cover"
          />
        ) : (
          <ImagePlaceholder className="h-44 w-full" />
        )}
        {outOfStock && (
          <span className="absolute left-2 top-2 rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
            Out of stock
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <span className="w-fit rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
          {product.category}
        </span>
        <h3 className="font-semibold text-stone-800 transition group-hover:text-brand-700">
          {product.name}
        </h3>
        <p className="line-clamp-2 text-sm text-stone-500">
          {product.description}
        </p>
        <div className="mt-auto flex items-end justify-between gap-2 pt-2">
          <div>
            <p className="text-lg font-semibold text-stone-900">
              {formatPrice(product.price)}
            </p>
            {outOfStock && (
              <p className="text-xs font-semibold text-red-600">Out of stock</p>
            )}
          </div>
          <button
            onClick={handleAddToCart}
            onKeyDown={(event) => event.stopPropagation()}
            disabled={outOfStock}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
          >
            Add
          </button>
        </div>
      </div>
    </article>
  );
}
