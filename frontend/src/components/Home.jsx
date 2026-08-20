import { useEffect, useState } from "react";
import { fetchProducts } from "../api/products.js";
import ProductImage from "./ProductImage.jsx";
import { formatPrice } from "../lib/currency.js";

const VALUE_PROPS = [
  {
    title: "Real-time stock updates",
    description: "Inventory updates live as it changes, so what you see on a product page is what's actually available to buy.",
    icon: (
      <>
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
        <path d="M3 21v-5h5" />
      </>
    ),
  },
  {
    title: "Secure checkout",
    description: "Every order runs through an authenticated checkout with built-in verification, so a failure never leaves things half-done.",
    icon: (
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>
    ),
  },
  {
    title: "Fast order tracking",
    description: "Follow your order status live from confirmation to delivery, right from your account.",
    icon: (
      <>
        <path d="M3 7h11v9H3z" />
        <path d="M14 10h4l3 3v3h-7z" />
        <circle cx="7.5" cy="18" r="1.5" />
        <circle cx="17.5" cy="18" r="1.5" />
      </>
    ),
  },
];

export default function Home({ user, profile, onNavigate, onSelectProduct, onSignIn }) {
  const [featured, setFeatured] = useState([]);

  useEffect(() => {
    let cancelled = false;
    fetchProducts({ limit: 4 })
      .then((data) => { if (!cancelled) setFeatured(data.items || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const collage = featured.length > 0 ? featured : [null, null, null, null];

  return (
    <div className="space-y-20 pb-6">
      <section className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-brand-600">SmartRetailX</p>
          <h1 className="mt-4 font-serif text-4xl font-semibold leading-tight text-stone-900 sm:text-5xl">
            {user ? `Welcome back${profile?.givenName ? `, ${profile.givenName}` : ""}.` : "Good taste, delivered."}
          </h1>
          <p className="mt-5 max-w-md text-lg text-stone-600">
            A curated catalogue, real-time stock you can trust, and an order journey you can actually follow — from checkout to your door.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <button
              onClick={() => onNavigate("catalogue")}
              className="rounded-md bg-brand-600 px-6 py-3 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Shop the collection
            </button>
            {user ? (
              <button
                onClick={() => onNavigate("orders")}
                className="rounded-md border border-stone-300 px-6 py-3 text-sm font-medium text-stone-700 hover:bg-stone-100"
              >
                Track your orders
              </button>
            ) : (
              <button
                onClick={onSignIn}
                className="rounded-md border border-stone-300 px-6 py-3 text-sm font-medium text-stone-700 hover:bg-stone-100"
              >
                Sign in
              </button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {collage.slice(0, 4).map((product, index) => (
            <div
              key={product?.id ?? index}
              className={`aspect-square overflow-hidden rounded-2xl bg-stone-100 ${index % 2 === 1 ? "mt-8" : ""}`}
            >
              <ProductImage src={product?.image_url} alt={product?.name ?? ""} className="h-full w-full object-cover" />
            </div>
          ))}
        </div>
      </section>

      {featured.length > 0 && (
        <section>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-brand-600">New in</p>
              <h2 className="mt-2 font-serif text-3xl font-semibold text-stone-900">Shop the edit</h2>
            </div>
            <button onClick={() => onNavigate("catalogue")} className="text-sm font-medium text-brand-700 hover:text-brand-900">
              Browse full catalogue →
            </button>
          </div>
          <div className="mt-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
            {featured.map((product) => (
              <button key={product.id} onClick={() => onSelectProduct(product.id)} className="group text-left">
                <div className="aspect-square overflow-hidden rounded-xl bg-stone-100">
                  <ProductImage
                    src={product.image_url}
                    alt={product.name}
                    className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                  />
                </div>
                <p className="mt-3 font-medium text-stone-900">{product.name}</p>
                <p className="text-sm text-stone-500">{formatPrice(product.price)}</p>
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-brand-600">Why SmartRetailX</p>
        <h2 className="mt-2 font-serif text-3xl font-semibold text-stone-900">Built for a better shopping experience</h2>
        <div className="mt-10 grid gap-8 sm:grid-cols-3">
          {VALUE_PROPS.map((item) => (
            <div key={item.title}>
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                  {item.icon}
                </svg>
              </div>
              <h3 className="mt-4 text-lg font-semibold text-stone-900">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-stone-600">{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl bg-brand-900 px-8 py-12 text-center text-white sm:px-16">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-brand-200">Get in touch</p>
        <h2 className="mt-2 font-serif text-3xl font-semibold">We're here to help</h2>
        <p className="mx-auto mt-3 max-w-md text-brand-100">
          Questions about an order or the catalogue? Reach out and we'll get back to you.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm">
          <a href="mailto:support@smartretailx.com" className="font-medium text-white hover:text-brand-200">
            support@smartretailx.com
          </a>
          <span className="text-brand-300">Mon–Fri, 9am–6pm</span>
        </div>
      </section>
    </div>
  );
}
