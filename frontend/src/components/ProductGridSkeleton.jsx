// Shaped like the grid it's standing in for (ProductGrid/ProductCard),
// rather than a generic spinner — this reads as "the page is nearly here"
// instead of "something unrelated is happening".
function Bone({ className = "" }) {
  return <div className={`overflow-hidden rounded-md bg-cream-200 ${className}`}><div className="h-full w-full animate-shimmer" /></div>;
}

function CardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl bg-white shadow-luxe-sm" aria-hidden="true">
      <Bone className="h-48 w-full rounded-none" />
      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <Bone className="h-4 w-16 rounded-full" />
        <Bone className="h-4 w-3/4" />
        <Bone className="h-3 w-full" />
        <Bone className="h-3 w-2/3" />
        <div className="mt-auto flex items-end justify-between gap-2 pt-3">
          <Bone className="h-5 w-14" />
          <Bone className="h-8 w-16 rounded-full" />
        </div>
      </div>
    </div>
  );
}

export default function ProductGridSkeleton({ count = 8 }) {
  return (
    <div role="status" aria-label="Loading products" className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: count }, (_, index) => <CardSkeleton key={index} />)}
    </div>
  );
}
