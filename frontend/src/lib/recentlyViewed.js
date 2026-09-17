// Remembers the last few products someone opened, purely in this browser —
// same mechanism the basket already uses (localStorage), so it disappears
// with cleared site data and never syncs across devices. That's intentional:
// it's a personal browsing trail, not account data.
const STORAGE_KEY = "smartretailx.recentlyViewed";
const MAX_ITEMS = 8;

function read() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordProductView(product) {
  if (!product?.id) return;
  const current = read().filter((item) => item.id !== product.id);
  const next = [
    { id: product.id, name: product.name, price: product.price, image_url: product.image_url },
    ...current,
  ].slice(0, MAX_ITEMS);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable (private browsing) — recently-viewed is a
    // nice-to-have, not worth surfacing an error over.
  }
}

// excludeId lets a page ask for "recently viewed, minus whatever I'm
// showing right now" (e.g. Home excluding nothing, a product page
// excluding itself) without every call site re-filtering by hand.
export function getRecentlyViewed(excludeId) {
  return read().filter((item) => item.id !== excludeId);
}
