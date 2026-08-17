import { useEffect, useState } from "react";
import { useAuth } from "./auth/AuthProvider.jsx";
import ProductGrid from "./components/ProductGrid.jsx";
import ProductDetail from "./components/ProductDetail.jsx";
import CartPage from "./components/CartPage.jsx";
import OrdersPage from "./components/OrdersPage.jsx";
import AdminPanel from "./components/AdminPanel.jsx";
import CustomersOrdersPage from "./components/CustomersOrdersPage.jsx";
import Dashboard from "./components/Dashboard.jsx";
import CustomerNavbar from "./components/CustomerNavbar.jsx";
import AdminNavbar from "./components/AdminNavbar.jsx";
import AccessDenied from "./components/AccessDenied.jsx";
import NotFound from "./components/NotFound.jsx";
import Toast from "./components/Toast.jsx";
import { consumeReturnRoute } from "./lib/checkoutDraft.js";

const CART_KEY = "smartretailx.cart";
const KNOWN_ROUTES = ["catalogue", "cart", "orders", "admin", "dashboard", "customers"];

const PAGE_TITLES = {
  catalogue: "Shop",
  cart: "Your basket",
  orders: "Your orders",
  dashboard: "Dashboard",
  admin: "Products & orders",
  customers: "Customers & orders",
  notfound: "Page not found",
};

// Distinct from "no hash yet" (a fresh landing, defaults to the shop) —
// an actual unrecognised hash (a stale bookmark, a typo) gets its own
// "Page not found" state instead of silently pretending nothing's wrong.
function routeFromHash() {
  const route = window.location.hash.replace("#", "");
  if (!route) return "catalogue";
  return KNOWN_ROUTES.includes(route) ? route : "notfound";
}

export default function App() {
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [route, setRoute] = useState(routeFromHash);
  const [cart, setCart] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem(CART_KEY)) || []; }
    catch { return []; }
  });
  const [latestOrder, setLatestOrder] = useState(null);
  const [toast, setToast] = useState(null);
  const { status, error, user, idToken, isAdmin, signIn, signOut } = useAuth();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onHashChange = () => { setSelectedProductId(null); setRoute(routeFromHash()); };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(CART_KEY, JSON.stringify(cart));
  }, [cart]);

  useEffect(() => {
    const page = selectedProductId ? "Product" : PAGE_TITLES[route] || "";
    document.title = page || "SmartRetailX";
  }, [route, selectedProductId]);

  function navigate(nextRoute) {
    window.location.hash = nextRoute;
  }

  useEffect(() => {
    if (status !== "ready") return;

    // Coming back from a mid-checkout sign-in detour takes priority over
    // everything else here — including the admin auto-redirect below, on
    // the reasoning that "finish what you were doing" beats "go to your
    // usual landing page" for an account that happens to be both.
    const returnRoute = consumeReturnRoute();
    if (returnRoute) {
      navigate(returnRoute);
      return;
    }

    // Only on a fresh landing with no route chosen yet — an admin who
    // deliberately clicks "View store" gets a real hash (#catalogue) and
    // this must not fight that choice on the next render.
    if (isAdmin && !window.location.hash) {
      navigate("dashboard");
    }
  }, [status, isAdmin]);

  function addToCart(product) {
    setCart((current) => {
      const existing = current.find((item) => item.id === product.id);
      if (existing) return current.map((item) => item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item);
      return [...current, { id: product.id, name: product.name, price: product.price, image_url: product.image_url, quantity: 1 }];
    });
    // No longer jumps straight to the cart page — that made adding a second
    // or third item from the grid disruptive (you'd get yanked away every
    // time). A toast confirms it instead; the basket link is right there
    // in the nav whenever you're ready to check out.
    setToast({ message: `${product.name} added to cart`, key: Date.now() });
  }

  function setQuantity(productId, rawQuantity) {
    const quantity = Math.max(1, Math.min(99, Number(rawQuantity) || 1));
    setCart((current) => current.map((item) => item.id === productId ? { ...item, quantity } : item));
  }

  return (
    <div className="min-h-screen bg-stone-50">
      <Toast message={toast?.message} key={toast?.key} />
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
          <ProductGrid onSelectProduct={setSelectedProductId} onAddToCart={addToCart} idToken={idToken} />
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
        ) : route === "customers" && isAdmin ? (
          <CustomersOrdersPage idToken={idToken} />
        ) : route === "notfound" ? (
          <NotFound onGoHome={() => navigate("catalogue")} />
        ) : (
          <AccessDenied onSignIn={() => signIn().catch((signInError) => window.alert(signInError.message))} />
        )}
      </main>
    </div>
  );
}
