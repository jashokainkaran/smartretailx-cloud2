import { useState } from "react";
import ProductGrid from "./components/ProductGrid.jsx";
import ProductDetail from "./components/ProductDetail.jsx";

export default function App() {
  const [selectedProductId, setSelectedProductId] = useState(null);

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="sticky top-0 z-10 border-b border-stone-200 bg-white/90 backdrop-blur">
        <div className="mx-auto max-w-7xl px-6 py-4">
          <button
            onClick={() => setSelectedProductId(null)}
            className="text-left"
          >
            <h1 className="text-xl font-bold tracking-tight text-stone-900">
              SmartRetail<span className="text-brand-600">X</span>
            </h1>
            <p className="text-sm text-stone-500">Product Catalogue</p>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10">
        {selectedProductId ? (
          <ProductDetail
            productId={selectedProductId}
            onBack={() => setSelectedProductId(null)}
          />
        ) : (
          <ProductGrid onSelectProduct={setSelectedProductId} />
        )}
      </main>
    </div>
  );
}
