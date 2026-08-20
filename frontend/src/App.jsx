import { useEffect, useState } from "react";
import { useAuth } from "./auth/AuthProvider.jsx";
import Home from "./components/Home.jsx";
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
import { fetchProductById } from "./api/products.js";
import { fetchCognitoProfile } from "./auth/cognitoUser.js";
import CompleteProfilePage from "./components/CompleteProfilePage.jsx";
import ProfilePage from "./components/ProfilePage.jsx";

const CART_KEY = "smartretailx.cart";
const KNOWN_ROUTES = ["home", "catalogue", "cart", "orders", "admin", "dashboard", "customers", "profile", "complete-profile"];

const PAGE_TITLES = {
  home: "SmartRetailX",
  catalogue: "Shop",
  cart: "Your basket",
  orders: "Your orders",
  dashboard: "Dashboard",
  admin: "Products & orders",
  customers: "Customers & orders",
  profile: "My Profile",
  "complete-profile": "Complete your profile",
  notfound: "Page not found",
};

// Distinct from "no hash yet" (a fresh landing, defaults to home) — an
// actual unrecognised hash (a stale bookmark, a typo) gets its own
// "Page not found" state instead of silently pretending nothing's wrong.
function routeFromLocation() {
  // Legacy hash links remain usable, but new navigation writes real browser
  // paths. CloudFront already rewrites 403/404 SPA paths to index.html.
  const legacyRoute = window.location.hash.replace("#", "");
  if (legacyRoute) return KNOWN_ROUTES.includes(legacyRoute) ? legacyRoute : "notfound";
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return "home";
  const route = path.slice(1);
  return KNOWN_ROUTES.includes(route) ? route : "notfound";
}

function pathForRoute(route) {
  return route === "home" ? "/" : `/${route}`;
}

export default function App() {
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [route, setRoute] = useState(routeFromLocation);
  const [cart, setCart] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem(CART_KEY)) || []; }
    catch { return []; }
  });
  const [latestOrder, setLatestOrder] = useState(null);
  const [toast, setToast] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileStatus, setProfileStatus] = useState("idle");
  const [profileError, setProfileError] = useState(null);
  const { status, error, user, idToken, accessToken, isAdmin, signIn, signOut } = useAuth();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onLocationChange = () => { setSelectedProductId(null); setRoute(routeFromLocation()); };
    window.addEventListener("popstate", onLocationChange);
    window.addEventListener("hashchange", onLocationChange);
    return () => {
      window.removeEventListener("popstate", onLocationChange);
      window.removeEventListener("hashchange", onLocationChange);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(CART_KEY, JSON.stringify(cart));
  }, [cart]);

  useEffect(() => {
    const page = selectedProductId ? "Product" : PAGE_TITLES[route] || "";
    document.title = page || "SmartRetailX";
  }, [route, selectedProductId]);

  function navigate(nextRoute) {
    const path = pathForRoute(nextRoute);
    if (window.location.pathname !== path || window.location.search || window.location.hash) {
      window.history.pushState({}, "", path);
    }
    setSelectedProductId(null);
    setRoute(nextRoute);
  }

  useEffect(() => {
    if (status !== "ready" || !user || !accessToken) {
      setProfile(null);
      setProfileStatus(user ? "error" : "idle");
      return undefined;
    }

    let cancelled = false;
    setProfileStatus("loading");
    setProfileError(null);
    fetchCognitoProfile(accessToken)
      .then((nextProfile) => {
        if (cancelled) return;
        setProfile(nextProfile);
        setProfileStatus("ready");
      })
      .catch((loadError) => {
        if (cancelled) return;
        setProfileError(loadError.message || "Could not load your Cognito profile.");
        setProfileStatus("error");
      });
    return () => { cancelled = true; };
  }, [status, user, accessToken]);

  const profileIncomplete = Boolean(user && profileStatus === "ready" && (!profile?.givenName || !profile?.familyName));

  useEffect(() => {
    if (status !== "ready") return;

    // A profile completion requirement applies to both roles: names are an
    // account identity concern, not a customer-only order concern.
    if (user && profileStatus === "ready" && profileIncomplete) {
      if (route !== "complete-profile") navigate("complete-profile");
      return;
    }

    // Don't let a completed user browse back to the one-purpose completion
    // page. They can edit their details from My Profile instead.
    if (user && profileStatus === "ready" && route === "complete-profile") {
      navigate(isAdmin ? "dashboard" : "home");
      return;
    }

    // Wait for profile loading before returning an interrupted checkout; a
    // newly registered user must complete their name before placing an order.
    if (user && profileStatus !== "ready") return;

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
    if (isAdmin && window.location.pathname === "/" && !window.location.hash) {
      navigate("dashboard");
    }
  }, [status, user, profileStatus, profileIncomplete, route, isAdmin]);

  function addToCart(product, availableQuantity) {
    // availableQuantity is the stock level the caller (ProductCard/
    // ProductDetail) already fetched — undefined/null if that fetch hasn't
    // resolved yet, in which case this can't safely block the add and lets
    // it through, matching how the button itself only ever disables at zero.
    let blocked = false;
    setCart((current) => {
      const existing = current.find((item) => item.id === product.id);
      const currentQuantity = existing ? existing.quantity : 0;
      if (typeof availableQuantity === "number" && currentQuantity >= availableQuantity) {
        blocked = true;
        return current;
      }
      if (existing) return current.map((item) => item.id === product.id ? { ...item, quantity: item.quantity + 1 } : item);
      return [...current, { id: product.id, name: product.name, price: product.price, image_url: product.image_url, quantity: 1 }];
    });
    // No longer jumps straight to the cart page — that made adding a second
    // or third item from the grid disruptive (you'd get yanked away every
    // time). A toast confirms it instead; the basket link is right there
    // in the nav whenever you're ready to check out.
    setToast(blocked
      ? { message: `Only ${availableQuantity} of ${product.name} in stock — you already have that many in your basket.`, variant: "error", key: Date.now() }
      : { message: `${product.name} added to cart`, key: Date.now() });
  }

  function setQuantity(productId, rawQuantity) {
    const quantity = Math.max(1, Math.min(99, Number(rawQuantity) || 1));
    setCart((current) => current.map((item) => item.id === productId ? { ...item, quantity } : item));
  }

  async function refreshCartPrices(changes) {
    // The 409 tells us which products changed. Fetch their authoritative
    // public catalogue records, then replace only those local basket
    // snapshots; quantities stay exactly as the customer chose them.
    const products = await Promise.all(
      changes.map((change) => fetchProductById(change.product_id, idToken)),
    );
    const byId = new Map(products.map((product) => [product.id, product]));

    setCart((current) => current.map((item) => {
      const product = byId.get(item.id);
      return product
        ? { ...item, name: product.name, price: product.price, image_url: product.image_url }
        : item;
    }));
  }

  return (
    <div className="min-h-screen bg-stone-50">
      <Toast message={toast?.message} variant={toast?.variant} key={toast?.key} />
      <header className="sticky top-0 z-10 border-b border-stone-200 bg-white/90 backdrop-blur relative">
        <div className="mx-auto max-w-7xl px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <button
              onClick={() => { setSelectedProductId(null); navigate(isAdmin ? "dashboard" : "home"); }}
              className="text-left"
            >
              <h1 className="text-xl font-bold tracking-tight text-stone-900">
                SmartRetail<span className="text-brand-600">X</span>
              </h1>
              {isAdmin && <p className="text-sm text-stone-500">Administrator</p>}
            </button>

            {route === "complete-profile" ? null : isAdmin ? (
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
        {profileError && user && (
          <div className="mb-6 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
            Could not load your account profile: {profileError}
          </div>
        )}
        {selectedProductId ? (
          <ProductDetail
            productId={selectedProductId}
            onBack={() => setSelectedProductId(null)}
            onAddToCart={addToCart}
            idToken={idToken}
          />
        ) : route === "home" ? (
          <Home
            user={user}
            profile={profile}
            onNavigate={navigate}
            onSelectProduct={setSelectedProductId}
            onSignIn={() => signIn().catch((signInError) => window.alert(signInError.message))}
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
            profile={profile}
            onSignIn={() => signIn().catch((signInError) => window.alert(signInError.message))}
            onOrderCreated={(order) => {
              setLatestOrder(order);
              setToast({ message: "Order placed!", variant: "success", key: Date.now() });
              navigate("orders");
            }}
            onRefreshPrices={refreshCartPrices}
          />
        ) : route === "orders" && user ? (
          <OrdersPage idToken={idToken} latestOrder={latestOrder} />
        ) : route === "complete-profile" && user && profileStatus === "ready" ? (
          <CompleteProfilePage
            accessToken={accessToken}
            profile={profile}
            onCompleted={(nextProfile) => { setProfile(nextProfile); navigate(isAdmin ? "dashboard" : "home"); }}
          />
        ) : route === "profile" && user && profileStatus === "ready" ? (
          <ProfilePage
            accessToken={accessToken}
            profile={profile}
            onProfileUpdated={setProfile}
            onSignOut={signOut}
          />
        ) : route === "dashboard" && isAdmin ? (
          <Dashboard idToken={idToken} onNavigate={navigate} />
        ) : route === "admin" && isAdmin ? (
          <AdminPanel idToken={idToken} />
        ) : route === "customers" && isAdmin ? (
          <CustomersOrdersPage idToken={idToken} />
        ) : route === "notfound" ? (
          <NotFound onGoHome={() => navigate("home")} />
        ) : (
          <AccessDenied onSignIn={() => signIn().catch((signInError) => window.alert(signInError.message))} />
        )}
      </main>
    </div>
  );
}
