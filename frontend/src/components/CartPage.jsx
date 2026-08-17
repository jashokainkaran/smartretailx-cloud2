import { useEffect, useState } from "react";
import { createOrder } from "../api/orders.js";
import { formatPrice } from "../lib/currency.js";
import { validateEmail, validatePhone, validateRequired } from "../lib/validation.js";
import CardFields, { deriveMockToken, validateCard } from "./CardFields.jsx";
import ImagePlaceholder from "./ImagePlaceholder.jsx";
import { consumeCheckoutDraft, saveCheckoutDraft } from "../lib/checkoutDraft.js";

const blankAddress = { recipient_name: "", street: "", city: "", postal_code: "", country: "" };
const blankCard = { number: "", expiry: "", cvv: "" };

const FIELD_LABELS = {
  recipient_name: "Recipient name",
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
    recipient_name: validateRequired(form.address.recipient_name, "Recipient name"),
    street: validateRequired(form.address.street, "Street"),
    city: validateRequired(form.address.city, "City"),
    postal_code: validateRequired(form.address.postal_code, "Postal code"),
    country: validateRequired(form.address.country, "Country"),
    contact_email: validateEmail(form.contactEmail),
    contact_phone: validatePhone(form.contactPhone),
    ...(form.paymentMethod === "card" ? validateCard(form.card) : {}),
  };
}

function hasErrors(errors) {
  return Object.values(errors).some(Boolean);
}

export default function CartPage({ cart, setQuantity, removeItem, clearCart, idToken, user, onOrderCreated, onSignIn }) {
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

  // Restores whatever was typed before the sign-in redirect, if anything —
  // one-time, consumed on read, so it can't resurrect a stale draft on a
  // later, unrelated visit to this page.
  useEffect(() => {
    const draft = consumeCheckoutDraft();
    if (draft) setForm((current) => ({ ...current, ...draft }));
  }, []);

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
    try {
      const order = await createOrder({
        idToken,
        items: cart.map((item) => ({ product_id: item.id, quantity: item.quantity })),
        shippingAddress: form.address,
        contactEmail: form.contactEmail,
        contactPhone: form.contactPhone,
        paymentMethod: form.paymentMethod,
        paymentToken: form.paymentMethod === "card" ? deriveMockToken(form.card) : undefined,
      });
      clearCart();
      onOrderCreated(order);
    } catch (checkoutError) {
      setError(checkoutError.message);
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
              {item.image_url ? (
                <img src={item.image_url} alt={item.name} className="h-16 w-16 shrink-0 rounded-lg object-cover" />
              ) : (
                <ImagePlaceholder className="h-16 w-16 shrink-0 rounded-lg" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-stone-900">{item.name}</p>
                <p className="text-sm text-stone-500">{formatPrice(item.price)} each</p>
              </div>
              <label className="text-sm text-stone-600">
                <span className="sr-only">Quantity for {item.name}</span>
                <input
                  type="number" min="1" max="99" value={item.quantity}
                  onChange={(event) => setQuantity(item.id, event.target.value)}
                  className="w-16 rounded-md border border-stone-300 px-2 py-1.5"
                />
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
            <TextField
              label="Recipient name" value={form.address.recipient_name} autoComplete="name"
              onChange={(v) => updateAddress("recipient_name", v)}
              onBlur={() => touch("recipient_name")} error={showError("recipient_name") && errors.recipient_name}
            />
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
            <TextField
              label="Country" value={form.address.country} autoComplete="country-name"
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

function EmptyCart() {
  return (
    <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-20 text-center">
      <h2 className="text-xl font-bold text-stone-900">Your basket is empty</h2>
      <p className="mt-2 text-sm text-stone-500">Choose a product from the catalogue to begin.</p>
    </div>
  );
}
