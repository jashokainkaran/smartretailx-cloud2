import { useEffect, useState } from "react";
import { createOrder } from "../api/orders.js";
import { fetchStock } from "../api/inventory.js";
import { formatPrice } from "../lib/currency.js";
import { validateEmail, validatePhone, validatePostalCode, validateRequired } from "../lib/validation.js";
import { COUNTRIES } from "../lib/countries.js";
import CardFields, { deriveMockToken, validateCard } from "./CardFields.jsx";
import ProductImage from "./ProductImage.jsx";
import { consumeCheckoutDraft, saveCheckoutDraft } from "../lib/checkoutDraft.js";

const blankAddress = { recipient_first_name: "", recipient_last_name: "", street: "", city: "", postal_code: "", country: "" };
const blankCard = { number: "", expiry: "", cvv: "" };

const FIELD_LABELS = {
  recipient_first_name: "Recipient first name",
  recipient_last_name: "Recipient last name",
  street: "Street address",
  city: "City",
  postal_code: "Postal code",
  country: "Country",
  contact_email: "Email",
  contact_phone: "Phone number",
  number: "Card number",
  expiry: "Card expiry",
  cvv: "CVV",
};

function validateAll(form) {
  return {
    recipient_first_name: validateRequired(form.address.recipient_first_name, "Recipient first name"),
    recipient_last_name: validateRequired(form.address.recipient_last_name, "Recipient last name"),
    street: validateRequired(form.address.street, "Street"),
    city: validateRequired(form.address.city, "City"),
    postal_code: validatePostalCode(form.address.postal_code),
    country: validateRequired(form.address.country, "Country"),
    contact_email: validateEmail(form.contactEmail),
    contact_phone: validatePhone(form.contactPhone),
    ...(form.paymentMethod === "card" ? validateCard(form.card) : {}),
  };
}

function hasErrors(errors) {
  return Object.values(errors).some(Boolean);
}

export default function CartPage({ cart, setQuantity, removeItem, clearCart, idToken, user, profile, onOrderCreated, onSignIn, onRefreshPrices }) {
  const [form, setForm] = useState({
    address: blankAddress,
    contactEmail: user?.email || "",
    contactPhone: "",
    paymentMethod: "card",
    card: blankCard,
  });
  const [touched, setTouched] = useState({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [priceChanges, setPriceChanges] = useState(null);
  const [refreshNotice, setRefreshNotice] = useState(null);
  const [stockByProductId, setStockByProductId] = useState({});

  // Keyed on the SET of product ids in the basket, not the cart array itself
  // — editing a quantity must not re-trigger this fetch, only adding or
  // removing a distinct product should.
  const cartProductIds = cart.map((item) => item.id).join(",");
  useEffect(() => {
    let cancelled = false;
    cart.forEach((item) => {
      fetchStock(item.id, idToken)
        .then((stock) => {
          if (!cancelled) setStockByProductId((current) => ({ ...current, [item.id]: stock.available_quantity }));
        })
        // A stock lookup failing (e.g. no inventory record yet) must not
        // block editing the quantity — just leave that item's cap unknown.
        .catch(() => {});
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartProductIds, idToken]);

  // A plain-text checkout failure (unknown/deactivated product, payment
  // declined, network error) clears itself after a while — long enough to
  // read, unlike the 2.5s toast. The price-changed case is deliberately
  // excluded: it carries the "Refresh basket prices" button, the customer's
  // actual way to recover, so it must stay until they act on it or resubmit.
  useEffect(() => {
    if (!error || priceChanges) return;
    const timer = setTimeout(() => setError(null), 7000);
    return () => clearTimeout(timer);
  }, [error, priceChanges]);

  // Restores whatever was typed before the sign-in redirect, if anything —
  // one-time, consumed on read, so it can't resurrect a stale draft on a
  // later, unrelated visit to this page.
  useEffect(() => {
    const draft = consumeCheckoutDraft();
    if (!draft) return;
    // Drafts created by the older one-field checkout are still safe to use.
    // Split the saved display name once rather than silently throwing it away.
    const legacyName = draft.address?.recipient_name?.trim();
    const [recipient_first_name, ...remainingName] = legacyName ? legacyName.split(/\s+/) : [];
    setForm((current) => ({
      ...current,
      ...draft,
      address: {
        ...current.address,
        ...draft.address,
        recipient_first_name: draft.address?.recipient_first_name || recipient_first_name || "",
        recipient_last_name: draft.address?.recipient_last_name || remainingName.join(" "),
      },
    }));
  }, []);

  // A delivery recipient can be someone else, so profile values are only an
  // initial convenience. Once a customer has typed a recipient name (or a
  // checkout draft was restored), we never overwrite it.
  useEffect(() => {
    if (!profile?.givenName && !profile?.familyName) return;
    setForm((current) => {
      if (current.address.recipient_first_name || current.address.recipient_last_name) return current;
      return {
        ...current,
        address: {
          ...current.address,
          recipient_first_name: profile.givenName || "",
          recipient_last_name: profile.familyName || "",
        },
        contactEmail: current.contactEmail || profile.email || "",
      };
    });
  }, [profile?.givenName, profile?.familyName, profile?.email]);

  const total = cart.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
  const errors = validateAll(form);
  const showError = (field) => (touched[field] || submitAttempted) && errors[field];

  function updateAddress(field, value) {
    setForm((current) => ({ ...current, address: { ...current.address, [field]: value } }));
  }

  function touch(field) {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  async function checkout(event) {
    event.preventDefault();
    setSubmitAttempted(true);
    if (hasErrors(errors)) return;

    if (!idToken) {
      // Only reached once the form is actually valid — no point taking the
      // sign-in detour for something that wasn't ready to submit anyway.
      saveCheckoutDraft({
        address: form.address,
        contactEmail: form.contactEmail,
        contactPhone: form.contactPhone,
        paymentMethod: form.paymentMethod,
      }, "cart");
      onSignIn();
      return;
    }

    setSubmitting(true);
    setError(null);
    setPriceChanges(null);
    setRefreshNotice(null);
    try {
      const order = await createOrder({
        idToken,
        // This is the price the customer saw, not a price the backend trusts.
        // The Order service compares it with the current catalogue price and
        // rejects the checkout safely if a change needs acknowledgement.
        items: cart.map((item) => ({
          product_id: item.id,
          quantity: item.quantity,
          expected_unit_price: String(item.price),
        })),
        // The Order Service's existing API deliberately retains one
        // recipient_name value. The UI captures a clearer first/last name
        // pair, then joins it at the boundary without changing an already
        // deployed order contract or historical order records.
        shippingAddress: {
          recipient_name: `${form.address.recipient_first_name.trim()} ${form.address.recipient_last_name.trim()}`.trim(),
          street: form.address.street,
          city: form.address.city,
          postal_code: form.address.postal_code,
          country: form.address.country,
        },
        contactEmail: form.contactEmail,
        contactPhone: form.contactPhone,
        paymentMethod: form.paymentMethod,
        paymentToken: form.paymentMethod === "card" ? deriveMockToken(form.card) : undefined,
      });
      clearCart();
      onOrderCreated(order);
    } catch (checkoutError) {
      if (checkoutError.status === 409 && checkoutError.details?.code === "PRICE_CHANGED") {
        setPriceChanges(checkoutError.details.changes);
      }
      setError(checkoutError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function refreshPrices() {
    if (!priceChanges || !onRefreshPrices) return;

    setSubmitting(true);
    try {
      await onRefreshPrices(priceChanges);
      setPriceChanges(null);
      setError(null);
      setRefreshNotice("Your basket prices were updated. Review the total, then place your order again.");
    } catch (refreshError) {
      setError(refreshError.message || "Could not refresh basket prices. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (cart.length === 0) {
    return <EmptyCart />;
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_26rem]">
      <section>
        <p className="text-sm font-medium text-brand-700">Your basket</p>
        <h2 className="mt-1 text-3xl font-bold tracking-tight text-stone-900">Ready when you are</h2>
        <div className="mt-6 divide-y divide-stone-200 rounded-xl border border-stone-200 bg-white">
          {cart.map((item) => (
            <div key={item.id} className="flex items-center gap-4 p-4">
              <ProductImage src={item.image_url} alt={item.name} className="h-16 w-16 shrink-0 rounded-lg object-cover" />
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-stone-900">{item.name}</p>
                <p className="text-sm text-stone-500">{formatPrice(item.price)} each</p>
              </div>
              <label className="text-sm text-stone-600">
                <span className="sr-only">Quantity for {item.name}</span>
                <input
                  type="number" min="1" max={stockByProductId[item.id] ?? 99} value={item.quantity}
                  onChange={(event) => {
                    const requested = Number(event.target.value) || 1;
                    const cap = stockByProductId[item.id];
                    setQuantity(item.id, typeof cap === "number" ? Math.min(requested, cap) : requested);
                  }}
                  className="w-16 rounded-md border border-stone-300 px-2 py-1.5"
                />
                {typeof stockByProductId[item.id] === "number" && (
                  <span className="mt-1 block text-xs text-stone-400">{stockByProductId[item.id]} in stock</span>
                )}
              </label>
              <p className="w-20 text-right font-semibold text-stone-900">{formatPrice(Number(item.price) * item.quantity)}</p>
              <button onClick={() => removeItem(item.id)} className="text-sm font-medium text-red-700 hover:text-red-900">Remove</button>
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-between rounded-xl border border-stone-200 bg-white px-5 py-4 text-sm">
          <span className="font-medium text-stone-600">Subtotal</span>
          <strong className="text-stone-900">{formatPrice(total)}</strong>
        </div>
      </section>

      <aside className="h-fit rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h3 className="text-lg font-bold text-stone-900">Checkout</h3>
        {!idToken && (
          <p className="mt-2 text-xs text-stone-500">
            You can fill this in now — sign-in is only needed to place the order.
          </p>
        )}

        <form onSubmit={checkout} className="mt-5 space-y-5" noValidate>
          {submitAttempted && hasErrors(errors) && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
              <p className="font-medium">
                {Object.values(errors).filter(Boolean).length} field{Object.values(errors).filter(Boolean).length === 1 ? "" : "s"} need{Object.values(errors).filter(Boolean).length === 1 ? "s" : ""} your attention:
              </p>
              <ul className="mt-1 list-inside list-disc">
                {Object.entries(errors).filter(([, msg]) => msg).map(([field]) => (
                  <li key={field}>{FIELD_LABELS[field] || field}</li>
                ))}
              </ul>
            </div>
          )}
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-stone-800">Delivery address</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField
                label="Recipient first name" value={form.address.recipient_first_name} autoComplete="given-name"
                onChange={(v) => updateAddress("recipient_first_name", v)}
                onBlur={() => touch("recipient_first_name")} error={showError("recipient_first_name") && errors.recipient_first_name}
              />
              <TextField
                label="Recipient last name" value={form.address.recipient_last_name} autoComplete="family-name"
                onChange={(v) => updateAddress("recipient_last_name", v)}
                onBlur={() => touch("recipient_last_name")} error={showError("recipient_last_name") && errors.recipient_last_name}
              />
            </div>
            <TextField
              label="Street address" value={form.address.street} autoComplete="street-address"
              onChange={(v) => updateAddress("street", v)}
              onBlur={() => touch("street")} error={showError("street") && errors.street}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField
                label="City" value={form.address.city} autoComplete="address-level2"
                onChange={(v) => updateAddress("city", v)}
                onBlur={() => touch("city")} error={showError("city") && errors.city}
              />
              <TextField
                label="Postal code" value={form.address.postal_code} autoComplete="postal-code"
                onChange={(v) => updateAddress("postal_code", v)}
                onBlur={() => touch("postal_code")} error={showError("postal_code") && errors.postal_code}
              />
            </div>
            <SelectField
              label="Country" value={form.address.country} autoComplete="country-name"
              options={COUNTRIES}
              onChange={(v) => updateAddress("country", v)}
              onBlur={() => touch("country")} error={showError("country") && errors.country}
            />
          </fieldset>

          <fieldset className="space-y-3 border-t border-stone-100 pt-5">
            <legend className="text-sm font-semibold text-stone-800">Contact details</legend>
            <TextField
              label="Email" type="email" value={form.contactEmail} autoComplete="email"
              onChange={(v) => setForm((c) => ({ ...c, contactEmail: v }))}
              onBlur={() => touch("contact_email")} error={showError("contact_email") && errors.contact_email}
            />
            <TextField
              label="Phone number" type="tel" value={form.contactPhone} autoComplete="tel"
              onChange={(v) => setForm((c) => ({ ...c, contactPhone: v }))}
              onBlur={() => touch("contact_phone")} error={showError("contact_phone") && errors.contact_phone}
            />
          </fieldset>

          <fieldset className="space-y-3 border-t border-stone-100 pt-5">
            <legend className="text-sm font-semibold text-stone-800">Payment method</legend>
            <div className="grid grid-cols-2 gap-3">
              <PaymentOption
                value="card"
                selected={form.paymentMethod === "card"}
                onSelect={() => setForm((c) => ({ ...c, paymentMethod: "card" }))}
                label="Card"
                icon={<CardGlyph />}
              />
              <PaymentOption
                value="cash_on_delivery"
                selected={form.paymentMethod === "cash_on_delivery"}
                onSelect={() => setForm((c) => ({ ...c, paymentMethod: "cash_on_delivery" }))}
                label="Cash on delivery"
                icon={<CashGlyph />}
              />
            </div>

            {form.paymentMethod === "card" ? (
              <CardFields
                card={form.card}
                onChange={(card) => setForm((c) => ({ ...c, card }))}
                errors={errors}
                touched={submitAttempted ? { number: true, expiry: true, cvv: true } : touched}
                onBlur={touch}
              />
            ) : (
              <p className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs leading-relaxed text-stone-600">
                Pay in cash when your order arrives. Your order is confirmed and stock is reserved
                immediately — no charge happens now.
              </p>
            )}
          </fieldset>

          {priceChanges && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
              <p className="font-semibold">A price changed before your order was placed.</p>
              <ul className="mt-2 space-y-1">
                {priceChanges.map((change) => (
                  <li key={change.product_id}>
                    {change.name}: {formatPrice(change.expected_unit_price)} → {formatPrice(change.current_unit_price)}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={refreshPrices}
                disabled={submitting}
                className="mt-3 rounded-md border border-amber-700 px-3 py-1.5 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-60"
              >
                Refresh basket prices
              </button>
            </div>
          )}
          {refreshNotice && (
            <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" role="status">
              {refreshNotice}
            </p>
          )}
          {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
          <div className="flex items-center justify-between border-t border-stone-200 pt-4 text-sm">
            <span className="text-stone-600">Total</span>
            <strong className="text-lg text-stone-900">{formatPrice(total)}</strong>
          </div>
          <button disabled={submitting} className="w-full rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
            {submitting ? "Placing order…" : idToken ? "Place order" : "Sign in to checkout"}
          </button>
        </form>
      </aside>
    </div>
  );
}

function PaymentOption({ value, selected, onSelect, label, icon }) {
  return (
    <label
      className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border-2 p-3 text-center text-sm font-medium transition ${
        selected ? "border-brand-500 bg-brand-50 text-brand-800" : "border-stone-200 text-stone-600 hover:border-stone-300"
      }`}
    >
      <input
        type="radio"
        name="payment_method"
        value={value}
        checked={selected}
        onChange={onSelect}
        className="sr-only"
      />
      {icon}
      {label}
    </label>
  );
}

function CardGlyph() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19" />
    </svg>
  );
}

function CashGlyph() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  );
}

function TextField({ label, value, onChange, onBlur, error, type = "text", autoComplete }) {
  return (
    <label className="block text-sm font-medium text-stone-700">
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        autoComplete={autoComplete}
        className={`mt-1 w-full rounded-md border px-3 py-2 transition focus:outline-none focus:ring-2 focus:ring-brand-400 ${error ? "border-red-400" : "border-stone-300 focus:border-brand-400"}`}
      />
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </label>
  );
}

function SelectField({ label, value, onChange, onBlur, error, options, autoComplete }) {
  return (
    <label className="block text-sm font-medium text-stone-700">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        autoComplete={autoComplete}
        className={`mt-1 w-full rounded-md border bg-white px-3 py-2 transition focus:outline-none focus:ring-2 focus:ring-brand-400 ${error ? "border-red-400" : "border-stone-300 focus:border-brand-400"}`}
      >
        <option value="">Select a country…</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </label>
  );
}

function EmptyCart() {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-20 text-center">
      <h2 className="text-xl font-bold text-stone-900">Your basket is empty</h2>
      <p className="mt-2 text-sm text-stone-500">Choose a product from the catalogue to begin.</p>
    </div>
  );
}
