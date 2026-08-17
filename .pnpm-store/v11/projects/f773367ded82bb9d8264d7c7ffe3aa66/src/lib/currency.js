/**
 * Currency formatting, defined once.
 *
 * All amounts in SmartRetailX are US dollars. Extracted into one module
 * rather than duplicated per component so that the cart, checkout and order
 * history added later cannot drift into formatting prices differently from
 * the product grid — and so that adding a second currency is one change
 * here rather than a search across the component tree.
 *
 * The API sends prices as JSON STRINGS, never numbers (ADR-039), so the
 * value arriving here is e.g. "1299.00". Number() converts it for
 * formatting only — the string form is what crosses the wire and what is
 * stored, and no arithmetic is ever performed on the float this produces.
 */
const priceFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatPrice(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  return priceFormatter.format(amount);
}

export default formatPrice;
