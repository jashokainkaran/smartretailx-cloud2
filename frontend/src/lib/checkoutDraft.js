// Survives the Cognito Hosted UI round trip: signing in is a full browser
// navigation away and back, which wipes all React state. sessionStorage is
// the same mechanism cognito.js already uses for the PKCE state/verifier
// during this exact redirect — session-scoped, gone when the tab closes.
//
// Deliberately does NOT include card fields (number/expiry/CVV) even though
// they never leave the browser — real payment forms almost universally make
// you re-enter card details after any interruption, and there's no reason
// for card-shaped data to sit in sessionStorage even briefly.
const DRAFT_KEY = "smartretailx.checkout_draft";
const RETURN_ROUTE_KEY = "smartretailx.post_signin_route";

export function saveCheckoutDraft(draft, returnRoute) {
  try {
    window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    window.sessionStorage.setItem(RETURN_ROUTE_KEY, returnRoute);
  } catch {
    // sessionStorage can throw (private browsing quotas, etc.) — losing the
    // draft is a minor inconvenience, not worth failing sign-in over.
  }
}

export function consumeCheckoutDraft() {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    window.sessionStorage.removeItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function consumeReturnRoute() {
  const route = window.sessionStorage.getItem(RETURN_ROUTE_KEY);
  if (route) window.sessionStorage.removeItem(RETURN_ROUTE_KEY);
  return route;
}
