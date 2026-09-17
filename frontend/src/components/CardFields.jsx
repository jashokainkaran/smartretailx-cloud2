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

// Formats as you type — "4242424242424242" becomes "4242 4242 4242 4242" —
// rather than requiring the space be typed. validateCardNumber already
// strips whitespace before checking, so this is purely cosmetic and never
// fights validation.
function formatCardNumber(rawValue) {
  const digits = rawValue.replace(/\D/g, "").slice(0, 19);
  return (digits.match(/.{1,4}/g) || []).join(" ");
}

// "1228" becomes "12/28" as it's typed. validateExpiry already tolerates
// optional whitespace around the slash, so this only ever adds the
// separator, never something the validator would reject.
function formatExpiry(rawValue) {
  const digits = rawValue.replace(/\D/g, "").slice(0, 4);
  return digits.length <= 2 ? digits : `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

// Prefix-based, not a full Luhn/BIN check — this only ever decides which
// small icon to show next to the field, not whether the number is valid,
// so a purely visual heuristic is all it needs to be.
function detectCardType(digits) {
  if (digits.startsWith("4")) return "visa";
  const firstTwo = Number(digits.slice(0, 2));
  const firstFour = Number(digits.slice(0, 4));
  if (firstTwo >= 51 && firstTwo <= 55) return "mastercard";
  if (firstFour >= 2221 && firstFour <= 2720) return "mastercard";
  return null;
}

export default function CardFields({ card, onChange, errors, touched, onBlur }) {
  const update = (field, value) => onChange({ ...card, [field]: value });
  const cardType = detectCardType(card.number.replace(/\D/g, ""));

  return (
    <div className="grid gap-3 rounded-xl border border-brand-900/10 bg-cream-100 p-4">
      <label className="text-sm font-medium text-stone-700">
        Card number
        <div className="relative">
          <input
            value={card.number}
            onChange={(event) => update("number", formatCardNumber(event.target.value))}
            onBlur={() => onBlur("number")}
            placeholder="4242 4242 4242 4242"
            inputMode="numeric"
            autoComplete="cc-number"
            className={`${inputClass(touched.number && errors.number)} pr-12`}
          />
          {cardType && (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
              {cardType === "visa" ? <VisaMark /> : <MastercardMark />}
            </span>
          )}
        </div>
        <FieldError show={touched.number} message={errors.number} />
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-stone-700">
          Expiry (MM/YY)
          <input
            value={card.expiry}
            onChange={(event) => update("expiry", formatExpiry(event.target.value))}
            onBlur={() => onBlur("expiry")}
            placeholder="12/28"
            inputMode="numeric"
            autoComplete="cc-exp"
            className={inputClass(touched.expiry && errors.expiry)}
          />
          <FieldError show={touched.expiry} message={errors.expiry} />
        </label>
        <label className="text-sm font-medium text-stone-700">
          CVV
          <input
            value={card.cvv}
            onChange={(event) => update("cvv", event.target.value.replace(/\D/g, "").slice(0, 4))}
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

// Simplified marks, not a reproduction of either brand's actual logo —
// enough to read as "this is a Visa/Mastercard number" at a glance in a
// small input-field icon, same spirit as any checkout form's card-type hint.
function VisaMark() {
  return (
    <span className="flex h-5 w-8 items-center justify-center rounded bg-[#1434CB] text-[9px] font-bold italic tracking-tight text-white">
      VISA
    </span>
  );
}

function MastercardMark() {
  return (
    <span className="relative flex h-5 w-8 items-center justify-center" aria-hidden="true">
      <span className="absolute left-1.5 h-4 w-4 rounded-full bg-[#EB001B]" />
      <span className="absolute right-1.5 h-4 w-4 rounded-full bg-[#F79E1B] mix-blend-multiply" />
    </span>
  );
}

function inputClass(hasError) {
  return `mt-1 w-full rounded-lg border bg-white px-3 py-2 transition focus:outline-none focus:ring-2 focus:ring-brand-200 ${hasError ? "border-red-400" : "border-stone-300 focus:border-brand-400"}`;
}

function FieldError({ show, message }) {
  if (!show || !message) return null;
  return <p className="mt-1 text-xs text-red-700">{message}</p>;
}
