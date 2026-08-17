import { validateCardNumber, validateExpiry, validateCvv } from "../lib/validation.js";

// A test card number ending in this suffix demonstrates a decline — mirrors
// the backend mock provider's own convention (any token containing
// "decline" is declined; see payment-service/app/providers/mock.py).
const DECLINE_SUFFIX = "0002";

// Derives a payment token FROM the card fields, in the browser, without
// ever sending the raw card number anywhere. This is deliberately not a
// real tokenising widget (Stripe Elements or similar) integrated against a
// live PSP — that is out of scope without a real provider account — but it
// preserves the property that actually matters: this component's onChange
// handlers never leave the browser, only the derived token crosses the
// network, exactly like a real one would.
export function deriveMockToken(card) {
  const digits = card.number.replace(/\s+/g, "");
  return digits.endsWith(DECLINE_SUFFIX) ? "tok_test_decline" : "tok_demo_success";
}

export function validateCard(card) {
  return {
    number: validateCardNumber(card.number),
    expiry: validateExpiry(card.expiry),
    cvv: validateCvv(card.cvv),
  };
}

export default function CardFields({ card, onChange, errors, touched, onBlur }) {
  const update = (field, value) => onChange({ ...card, [field]: value });

  return (
    <div className="grid gap-3 rounded-lg border border-stone-200 bg-stone-50 p-4">
      <label className="text-sm font-medium text-stone-700">
        Card number
        <input
          value={card.number}
          onChange={(event) => update("number", event.target.value)}
          onBlur={() => onBlur("number")}
          placeholder="4242 4242 4242 4242"
          inputMode="numeric"
          autoComplete="cc-number"
          className={inputClass(touched.number && errors.number)}
        />
        <FieldError show={touched.number} message={errors.number} />
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-stone-700">
          Expiry (MM/YY)
          <input
            value={card.expiry}
            onChange={(event) => update("expiry", event.target.value)}
            onBlur={() => onBlur("expiry")}
            placeholder="12/28"
            autoComplete="cc-exp"
            className={inputClass(touched.expiry && errors.expiry)}
          />
          <FieldError show={touched.expiry} message={errors.expiry} />
        </label>
        <label className="text-sm font-medium text-stone-700">
          CVV
          <input
            value={card.cvv}
            onChange={(event) => update("cvv", event.target.value)}
            onBlur={() => onBlur("cvv")}
            placeholder="123"
            inputMode="numeric"
            autoComplete="cc-csc"
            className={inputClass(touched.cvv && errors.cvv)}
          />
          <FieldError show={touched.cvv} message={errors.cvv} />
        </label>
      </div>

      <p className="text-xs leading-relaxed text-stone-500">
        Demo checkout — no live payment processor is connected. These fields are validated and
        turned into a token in your browser only; the card number itself is never sent to our
        servers. A number ending <code>{DECLINE_SUFFIX}</code> demonstrates a declined payment.
      </p>
    </div>
  );
}

function inputClass(hasError) {
  return `mt-1 w-full rounded-md border px-3 py-2 transition focus:outline-none focus:ring-2 focus:ring-brand-400 ${hasError ? "border-red-400" : "border-stone-300 focus:border-brand-400"}`;
}

function FieldError({ show, message }) {
  if (!show || !message) return null;
  return <p className="mt-1 text-xs text-red-700">{message}</p>;
}
