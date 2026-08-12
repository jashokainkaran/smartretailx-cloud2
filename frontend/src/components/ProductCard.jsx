import ImagePlaceholder from "./ImagePlaceholder.jsx";

const priceFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export default function ProductCard({ product, onSelect }) {
  return (
    <button
      onClick={() => onSelect(product.id)}
      className="group flex flex-col overflow-hidden rounded-xl border border-stone-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-400"
    >
      {product.image_url ? (
        <img
          src={product.image_url}
          alt={product.name}
          className="h-44 w-full object-cover"
        />
      ) : (
        <ImagePlaceholder className="h-44 w-full" />
      )}

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
        <p className="mt-auto pt-2 text-lg font-semibold text-stone-900">
          {priceFormatter.format(product.price)}
        </p>
      </div>
    </button>
  );
}
