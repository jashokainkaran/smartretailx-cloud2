import { useEffect, useState } from "react";
import { useAuth } from "./auth/AuthProvider.jsx";
import ProductGrid from "./components/ProductGrid.jsx";
import ProductDetail from "./components/ProductDetail.jsx";
import CartPage from "./components/CartPage.jsx";
import OrdersPage from "./components/OrdersPage.jsx";
import AdminPanel from "./components/AdminPanel.jsx";
import Dashboard from "./components/Dashboard.jsx";
import CustomerNavbar from "./components/CustomerNavbar.jsx";
import AdminNavbar from "./components/AdminNavbar.jsx";

const CART_KEY = "smartretailx.cart";

function routeFromHash() {
  const route = window.location.hash.replace("#", "");
  return ["catalogue", "cart", "orders", "admin", "dashboard"].includes(route) ? route : "catalogue";
}

export default function App() {
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [route, setRoute] = useState(routeFromHash);
  const [cart, setCart] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem(CART_KEY)) || []; }
    catch { return []; }
  });
  const [latestOrder, setLatestOrder] = useState(null);
  const { status, error, user, idToken, isAdmin, signIn, signOut } = useAuth();

  useEffect(() => {
    const onHashChange = () => { setSelectedProductId(null); setRoute(routeFromHash()); };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(CART_KEY, JSON.stringify(cart));
  }, [cart]);

  function navigate(nextRoute) {
    window.location.hash = nextRoute;
  }

  useEffect(() => {
    // Only on a fresh landing with no route chosen yet — an admin who
    // deliberately clicks "View store" gets a real hash (#catalogue) and
    // this must not fight that choice on the next render.
    if (status === "ready" && isAdmin && !window.location.hash) {
      navigate("dashboard");
    }
  }, [status, isAdmin]);

  function addToCart(product) {
    setCart((current) => {
      const existing = current.find((item) => item.id === product.id);
      if (existing) return current.map((item) => item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item);
      return [...current, { id: product.id, name: product.name, price: product.price, quantity: 1 }];
    });
    navigate("cart");
  }

  function setQuantity(productId, rawQuantity) {
    const quantity = Math.max(1, Math.min(99, Number(rawQuantity) || 1));
    setCart((current) => current.map((item) => item.id === productId ? { ...item, quantity } : item));
  }

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="sticky top-0 z-10 border-b border-stone-200 bg-white/90 backdrop-blur relative">
        <div className="mx-auto max-w-7xl px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <button
              onClick={() => { setSelectedProductId(null); navigate(isAdmin ? "dashboard" : "catalogue"); }}
              className="text-left"
            >
              <h1 className="text-xl font-bold tracking-tight text-stone-900">
                SmartRetail<span className="text-brand-600">X</span>
              </h1>
              <p className="text-sm text-stone-500">{isAdmin ? "Administrator" : "Product Catalogue"}</p>
            </button>

            {isAdmin ? (
              <AdminNavbar route={route} navigate={navigate} />
            ) : (
              <CustomerNavbar route={route} cart={cart} user={user} navigate={navigate} />
            )}

            {status === "loading" ? (
              <span className="text-sm text-stone-500">Checking sign-in…</span>
            ) : user ? (
              <div className="flex items-center gap-3 text-right">
                <div className="hidden sm:block">
                  <p className="text-sm font-medium text-stone-900">{user.email}</p>
                  <p className="text-xs text-stone-500">
                    {isAdmin ? "Administrator" : "Customer"}
                  </p>
                </div>
                <button
                  onClick={signOut}
                  className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <button
                onClick={() => signIn().catch((signInError) => window.alert(signInError.message))}
                className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10">
        {error && (
          <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert">
            {error}
          </div>
        )}
        {selectedProductId ? (
          <ProductDetail
            productId={selectedProductId}
            onBack={() => setSelectedProductId(null)}
            onAddToCart={addToCart}
            idToken={idToken}
          />
        ) : route === "catalogue" ? (
          <ProductGrid onSelectProduct={setSelectedProductId} idToken={idToken} />
        ) : route === "cart" ? (
          <CartPage
            cart={cart}
            setQuantity={setQuantity}
            removeItem={(id) => setCart((current) => current.filter((item) => item.id !== id))}
            clearCart={() => setCart([])}
            idToken={idToken}
            user={user}
            onSignIn={() => signIn().catch((signInError) => window.alert(signInError.message))}
            onOrderCreated={(order) => { setLatestOrder(order); navigate("orders"); }}
          />
        ) : route === "orders" && user ? (
          <OrdersPage idToken={idToken} latestOrder={latestOrder} />
        ) : route === "dashboard" && isAdmin ? (
          <Dashboard idToken={idToken} onNavigate={navigate} />
        ) : route === "admin" && isAdmin ? (
          <AdminPanel idToken={idToken} />
        ) : (
          <AccessDenied onSignIn={() => signIn().catch((signInError) => window.alert(signInError.message))} />
        )}
      </main>
    </div>
  );
}

function AccessDenied({ onSignIn }) {
  return <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-20 text-center"><h2 className="text-xl font-bold text-stone-900">Sign-in required</h2><p className="mt-2 text-sm text-stone-500">Please sign in to access this area.</p><button onClick={onSignIn} className="mt-5 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white">Sign in</button></div>;
}
