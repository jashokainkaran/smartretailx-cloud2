import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import * as Select from "@radix-ui/react-select";
import { createOrder } from "../api/orders.js";
import { fetchStock } from "../api/inventory.js";
import { formatPrice } from "../lib/currency.js";
import { validateEmail, validatePhone, validatePostalCode, validateRequired } from "../lib/validation.js";
import { COUNTRIES, COUNTRY_CODES } from "../lib/countries.js";
import CardFields, { deriveMockToken, validateCard } from "./CardFields.jsx";
import ProductImage from "./ProductImage.jsx";
import ProductCarousel from "./ProductCarousel.jsx";
import SuccessNotice from "./SuccessNotice.jsx";
import { consumeCheckoutDraft, saveCheckoutDraft } from "../lib/checkoutDraft.js";
import { getRecentlyViewed } from "../lib/recentlyViewed.js";

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

export default function CartPage({ cart, setQuantity, removeItem, clearCart, idToken, user, profile, onOrderCreated, onSignIn, onRefreshPrices, onSelectProduct, onNavigate }) {
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
        // A missing inventory record means there is nothing available to
        // sell. Other failures leave the cap unknown rather than treating a
        // temporary network problem as definitive zero stock.
        .catch((stockError) => {
          if (!cancelled && stockError.status === 404) {
            setStockByProductId((current) => ({ ...current, [item.id]: 0 }));
          }
        });
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
  const hasUnavailableItems = cart.some((item) => stockByProductId[item.id] === 0);
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
    return <EmptyCart onSelectProduct={onSelectProduct} onNavigate={onNavigate} />;
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_26rem]">
      <section>
        <p className="text-sm font-medium text-brand-700">Your basket</p>
        <h2 className="mt-1 font-serif text-3xl font-medium tracking-tight text-stone-900">Ready when you are</h2>
        <div className="mt-6 divide-y divide-brand-900/10 rounded-2xl bg-white shadow-luxe-sm">
          <AnimatePresence initial={false} mode="popLayout">
            {cart.map((item) => (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }}
                transition={{ duration: 0.25 }}
                className="flex flex-wrap items-center gap-4 p-4"
              >
                <ProductImage src={item.image_url} alt={item.name} className="h-16 w-16 shrink-0 rounded-xl object-cover" />
                <div className="min-w-[9rem] flex-1">
                  <p className="font-semibold text-stone-900">{item.name}</p>
                  <p className="text-sm text-stone-500">{formatPrice(item.price)} each</p>
                </div>
                <div className="ml-auto flex items-center gap-4">
                  <label className="text-sm text-stone-600">
                    <span className="sr-only">Quantity for {item.name}</span>
                    <input
                      type="number" min="1" max={Math.max(1, stockByProductId[item.id] ?? 99)} value={item.quantity}
                      aria-label={`Quantity for ${item.name}`}
                      disabled={stockByProductId[item.id] === 0}
                      onChange={(event) => {
                        const requested = Number(event.target.value) || 1;
                        const cap = stockByProductId[item.id];
                        setQuantity(item.id, typeof cap === "number" ? Math.min(requested, cap) : requested);
                      }}
                      className="w-16 rounded-lg border border-stone-300 px-2 py-1.5 transition focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-200 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-400"
                    />
                    {typeof stockByProductId[item.id] === "number" && (
                      <span className={`mt-1 block text-xs ${stockByProductId[item.id] === 0 ? "font-medium text-red-700" : "text-stone-400"}`}>
                        {stockByProductId[item.id] === 0 ? "Out of stock — remove to continue" : `${stockByProductId[item.id]} in stock`}
                      </span>
                    )}
                  </label>
                  <p className="tabular-nums w-16 text-right font-semibold text-stone-900 sm:w-20">{formatPrice(Number(item.price) * item.quantity)}</p>
                  <button onClick={() => removeItem(item.id)} className="text-sm font-medium text-red-700 transition hover:text-red-900">Remove</button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        <div className="mt-4 flex justify-between rounded-2xl bg-white px-5 py-4 text-sm shadow-luxe-sm">
          <span className="font-medium text-stone-600">Subtotal</span>
          <strong className="tabular-nums text-stone-900">{formatPrice(total)}</strong>
        </div>
      </section>

      <aside className="h-fit rounded-2xl bg-white p-5 shadow-luxe sm:p-6">
        <h3 className="font-serif text-xl font-semibold text-stone-900">Checkout</h3>
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
              label="Country" value={form.address.country}
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
            <SuccessNotice>
              {refreshNotice}
            </SuccessNotice>
          )}
          {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
          <div className="flex items-center justify-between border-t border-stone-200 pt-4 text-sm">
            <span className="text-stone-600">Total</span>
            <strong className="tabular-nums text-lg text-stone-900">{formatPrice(total)}</strong>
          </div>
          <button disabled={submitting || hasUnavailableItems} className="w-full rounded-full bg-brand-600 px-4 py-3 text-sm font-semibold text-white shadow-luxe-sm transition hover:-translate-y-0.5 hover:bg-brand-700 active:translate-y-0 disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-60">
            {submitting ? "Placing order…" : hasUnavailableItems ? "Remove unavailable items" : idToken ? "Place order" : "Sign in to checkout"}
          </button>
        </form>
      </aside>
    </div>
  );
}

function PaymentOption({ value, selected, onSelect, label, icon }) {
  return (
    <label
      className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border-2 p-3 text-center text-sm font-medium transition ${
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
        className={`mt-1 w-full rounded-lg border px-3 py-2 transition focus:outline-none focus:ring-2 focus:ring-brand-200 ${error ? "border-red-400" : "border-stone-300 focus:border-brand-400"}`}
      />
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </label>
  );
}

// A styled dropdown instead of the browser's bare native one, so the
// popup list actually matches the rest of the form (font, radius, the
// selected-item checkmark) rather than looking like a different app.
// Radix's own semantics (keyboard nav, ARIA) stand in for what a native
// <select> gives for free — the one thing genuinely lost is browser
// autofill, which a custom-rendered listbox can't hook into the way a
// real <select> can.
function SelectField({ label, value, onChange, onBlur, error, options }) {
  return (
    <div className="block text-sm font-medium text-stone-700">
      {label}
      <Select.Root value={value} onValueChange={onChange}>
        <Select.Trigger
          onBlur={onBlur}
          aria-label={label}
          className={`mt-1 flex w-full items-center justify-between gap-2 rounded-lg border bg-white px-3 py-2 text-left transition focus:outline-none focus:ring-2 focus:ring-brand-200 ${error ? "border-red-400" : "border-stone-300 focus:border-brand-400"}`}
        >
          <Select.Value placeholder="Select a country…" className={value ? "text-stone-900" : "text-stone-400"}>
            {value && (
              <span className="flex items-center gap-2">
                <CountryFlag name={value} className="h-3.5 w-5 shrink-0 rounded-sm" />
                {value}
              </span>
            )}
          </Select.Value>
          <Select.Icon>
            <ChevronIcon />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content position="popper" sideOffset={4} className="z-50 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-luxe">
            <Select.ScrollUpButton className="flex items-center justify-center py-1 text-stone-400">
              <ChevronIcon direction="up" />
            </Select.ScrollUpButton>
            <Select.Viewport className="max-h-64 p-1" style={{ width: "var(--radix-select-trigger-width)" }}>
              {options.map((option) => (
                <Select.Item
                  key={option}
                  value={option}
                  className="relative flex cursor-pointer select-none items-center rounded-md py-2 pl-3 pr-8 text-sm text-stone-700 outline-none transition data-[highlighted]:bg-brand-50 data-[highlighted]:text-brand-800"
                >
                  <span className="flex items-center gap-2">
                    <CountryFlag name={option} className="h-3.5 w-5 shrink-0 rounded-sm" />
                    <Select.ItemText>{option}</Select.ItemText>
                  </span>
                  <Select.ItemIndicator className="absolute right-3 flex items-center text-brand-600">
                    <CheckIcon />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
            <Select.ScrollDownButton className="flex items-center justify-center py-1 text-stone-400">
              <ChevronIcon direction="down" />
            </Select.ScrollDownButton>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  );
}

// Looks up a flag by name via COUNTRY_CODES rather than shipping a React
// component for every flag in the initial JavaScript bundle. An option with
// no matching code renders no flag, keeping this safe if the field is ever
// reused for a non-country list.
function CountryFlag({ name, className }) {
  const code = COUNTRY_CODES[name];
  if (!code) return null;
  const flag = String.fromCodePoint(...[...code].map((letter) => 127397 + letter.charCodeAt(0)));
  return <span className={`${className} inline-flex items-center justify-center text-sm leading-none`} aria-hidden="true">{flag}</span>;
}

function ChevronIcon({ direction = "down" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0">
      <path d={direction === "up" ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// Same "empty basket" message and styling either way — the only
// difference is whether a "Recently viewed" section follows it, when
// there's actually browsing history to show.
function EmptyCart({ onSelectProduct, onNavigate }) {
  const recentlyViewed = getRecentlyViewed();

  return (
    <div>
      <div className={recentlyViewed.length > 0 ? "pb-10" : "py-16 text-center"}>
        <h2 className="font-serif text-2xl font-medium text-stone-900">Your basket is empty</h2>
        <p className="mt-2 text-sm text-stone-500">Choose a product from the catalogue to begin.</p>
        <button
          onClick={() => onNavigate("catalogue")}
          className="mt-6 rounded-full bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white shadow-luxe-sm transition hover:-translate-y-0.5 hover:bg-brand-700 active:translate-y-0"
        >
          Browse the catalogue
        </button>
      </div>
      {recentlyViewed.length > 0 && (
        <div>
          <h3 className="font-serif text-2xl font-medium text-stone-900">Recently viewed</h3>
          <div className="mt-6">
            <ProductCarousel products={recentlyViewed} onSelectProduct={onSelectProduct} />
          </div>
        </div>
      )}
    </div>
  );
}
