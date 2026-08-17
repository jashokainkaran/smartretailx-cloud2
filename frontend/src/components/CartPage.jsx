import { useState } from "react";
import { createOrder } from "../api/orders.js";
import { formatPrice } from "../lib/currency.js";
import { validateEmail, validatePhone, validateRequired } from "../lib/validation.js";
import CardFields, { deriveMockToken, validateCard } from "./CardFields.jsx";

const blankAddress = { recipient_name: "", street: "", city: "", postal_code: "", country: "" };
const blankCard = { number: "", expiry: "", cvv: "" };

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
    if (!idToken) {
      onSignIn();
      return;
    }
    setSubmitAttempted(true);
    if (hasErrors(errors)) return;

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
      </section>

      <aside className="h-fit rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h3 className="text-lg font-bold text-stone-900">Checkout</h3>
        <div className="mt-4 flex justify-between border-b border-stone-200 pb-4 text-sm">
          <span className="text-stone-600">Order total</span><strong>{formatPrice(total)}</strong>
        </div>

        <form onSubmit={checkout} className="mt-5 space-y-5" noValidate>
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-stone-800">Delivery address</legend>
            <TextField
              label="Recipient name" value={form.address.recipient_name}
              onChange={(v) => updateAddress("recipient_name", v)}
              onBlur={() => touch("recipient_name")} error={showError("recipient_name") && errors.recipient_name}
            />
            <TextField
              label="Street address" value={form.address.street}
              onChange={(v) => updateAddress("street", v)}
              onBlur={() => touch("street")} error={showError("street") && errors.street}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField
                label="City" value={form.address.city}
                onChange={(v) => updateAddress("city", v)}
                onBlur={() => touch("city")} error={showError("city") && errors.city}
              />
              <TextField
                label="Postal code" value={form.address.postal_code}
                onChange={(v) => updateAddress("postal_code", v)}
                onBlur={() => touch("postal_code")} error={showError("postal_code") && errors.postal_code}
              />
            </div>
            <TextField
              label="Country" value={form.address.country}
              onChange={(v) => updateAddress("country", v)}
              onBlur={() => touch("country")} error={showError("country") && errors.country}
            />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-stone-800">Contact details</legend>
            <TextField
              label="Email" type="email" value={form.contactEmail}
              onChange={(v) => setForm((c) => ({ ...c, contactEmail: v }))}
              onBlur={() => touch("contact_email")} error={showError("contact_email") && errors.contact_email}
            />
            <TextField
              label="Phone number" type="tel" value={form.contactPhone}
              onChange={(v) => setForm((c) => ({ ...c, contactPhone: v }))}
              onBlur={() => touch("contact_phone")} error={showError("contact_phone") && errors.contact_phone}
            />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-stone-800">Payment</legend>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input
                  type="radio" name="payment_method" value="card"
                  checked={form.paymentMethod === "card"}
                  onChange={() => setForm((c) => ({ ...c, paymentMethod: "card" }))}
                />
                Card
              </label>
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input
                  type="radio" name="payment_method" value="cash_on_delivery"
                  checked={form.paymentMethod === "cash_on_delivery"}
                  onChange={() => setForm((c) => ({ ...c, paymentMethod: "cash_on_delivery" }))}
                />
                Cash on delivery
              </label>
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
          <button disabled={submitting} className="w-full rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
            {submitting ? "Placing order…" : idToken ? "Place order" : "Sign in to checkout"}
          </button>
        </form>
      </aside>
    </div>
  );
}

function TextField({ label, value, onChange, onBlur, error, type = "text" }) {
  return (
    <label className="block text-sm font-medium text-stone-700">
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className={`mt-1 w-full rounded-md border px-3 py-2 ${error ? "border-red-400" : "border-stone-300"}`}
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
