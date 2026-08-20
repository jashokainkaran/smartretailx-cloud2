// Client-side checkout validation. Deliberately mirrors the backend's own
// rules (order-service/app/models.py) rather than inventing stricter ones —
// live validation here is UX, the backend's own validators are what
// actually enforce correctness, and the two must agree or a field that
// passes here could still bounce as a 422 after submit.

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateRequired(value, label) {
  if (!value || !value.trim()) return `${label} is required.`;
  return null;
}

export function validateEmail(value) {
  if (!value || !value.trim()) return "Email is required.";
  if (!EMAIL_PATTERN.test(value.trim())) return "Enter a valid email address.";
  return null;
}

export function validatePostalCode(value) {
  if (!value || !value.trim()) return "Postal code is required.";
  // Deliberately loose rather than per-country: real postal code formats
  // vary too widely (UK "SW1A 1AA" vs US "94103" vs Japan "100-0001") for
  // one pattern to validate all of them correctly. This catches the actual
  // mistakes worth catching — empty, way too short, or garbage characters
  // — without rejecting a real address from a country this wasn't tested
  // against.
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9\s-]{1,9}$/.test(trimmed)) {
    return "Enter a valid postal code.";
  }
  return null;
}

export function validatePhone(value) {
  if (!value || !value.trim()) return "Phone number is required.";
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length < 7) return "Phone number is too short.";
  if (digits.length > 15) return "Phone number is too long.";
  return null;
}

export function validateCardNumber(value) {
  const digits = (value || "").replace(/\s+/g, "");
  if (!digits) return "Card number is required.";
  if (!/^\d{13,19}$/.test(digits)) return "Enter a valid card number.";
  return null;
}

export function validateExpiry(value) {
  const match = /^(\d{2})\s*\/\s*(\d{2})$/.exec((value || "").trim());
  if (!match) return "Use MM/YY format.";
  const month = Number(match[1]);
  if (month < 1 || month > 12) return "Enter a valid month.";
  const expiry = new Date(2000 + Number(match[2]), month); // first of the month AFTER expiry
  if (expiry <= new Date()) return "Card has expired.";
  return null;
}

export function validateCvv(value) {
  if (!/^\d{3,4}$/.test((value || "").trim())) return "Enter a valid CVV.";
  return null;
}
