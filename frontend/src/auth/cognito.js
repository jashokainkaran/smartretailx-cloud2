// Browser-side Cognito OAuth helpers. These values identify the application;
// they are deliberately not secrets. A React app must never contain an AWS key
// or Cognito client secret because a visitor could inspect the bundle.

const domain = import.meta.env.VITE_COGNITO_DOMAIN;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
const redirectUri = import.meta.env.VITE_COGNITO_REDIRECT_URI || window.location.origin;
const storageKey = "smartretailx.auth";
const stateKey = "smartretailx.oauth.state";
const verifierKey = "smartretailx.oauth.verifier";

function base64Url(bytes) {
  let value = "";
  bytes.forEach((byte) => {
    value += String.fromCharCode(byte);
  });

  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomValue() {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function pkceChallenge(verifier) {
  const bytes = new TextEncoder().encode(verifier);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return base64Url(new Uint8Array(digest));
}

function decodeJwtPayload(token) {
  const [, payload] = token.split(".");
  if (!payload) {
    throw new Error("Cognito returned an invalid ID token.");
  }

  const padded = payload.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
  return JSON.parse(atob(padded));
}

export function isConfigured() {
  return Boolean(domain && clientId);
}

export function configurationError() {
  return "Cognito is not configured. Copy .env.example to .env.local, then restart the Vite server.";
}

export function getStoredSession() {
  const rawSession = window.sessionStorage.getItem(storageKey);
  if (!rawSession) return null;

  try {
    const session = JSON.parse(rawSession);
    const claims = decodeJwtPayload(session.id_token);

    if (!session.id_token || !claims.exp || claims.exp * 1000 <= Date.now()) {
      clearStoredSession();
      return null;
    }

    return {
      tokens: session,
      user: {
        email: claims.email || claims["cognito:username"],
        username: claims["cognito:username"],
        groups: claims["cognito:groups"] || [],
      },
    };
  } catch {
    clearStoredSession();
    return null;
  }
}

export function clearStoredSession() {
  window.sessionStorage.removeItem(storageKey);
}

// Lets api/http.js reject an already-dead token before spending a round trip
// on it, and produce a clear message instead of a bare 401.
export function isTokenExpired(token) {
  try {
    const { exp } = decodeJwtPayload(token);
    return !exp || exp * 1000 <= Date.now();
  } catch {
    return true;
  }
}

export function isAuthenticationCallback() {
  const parameters = new URLSearchParams(window.location.search);
  return parameters.has("code") || parameters.has("error");
}

export async function beginSignIn() {
  if (!isConfigured()) throw new Error(configurationError());

  const state = randomValue();
  const verifier = randomValue();
  const challenge = await pkceChallenge(verifier);
  window.sessionStorage.setItem(stateKey, state);
  window.sessionStorage.setItem(verifierKey, verifier);

  const parameters = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    // This scope is deliberately requested alongside the normal OIDC scopes.
    // It permits a signed-in person to call Cognito's self-service account
    // APIs (profile, password and MFA) with their access token. It is not an
    // AWS administrator permission and cannot operate on another user.
    scope: "openid email profile aws.cognito.signin.user.admin",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  window.location.assign(`${domain}/oauth2/authorize?${parameters.toString()}`);
}

export async function completeSignIn() {
  if (!isConfigured()) throw new Error(configurationError());

  const parameters = new URLSearchParams(window.location.search);
  const providerError = parameters.get("error");
  if (providerError) {
    throw new Error(parameters.get("error_description") || providerError);
  }

  const code = parameters.get("code");
  const returnedState = parameters.get("state");
  const expectedState = window.sessionStorage.getItem(stateKey);
  const verifier = window.sessionStorage.getItem(verifierKey);

  if (!code || !returnedState || returnedState !== expectedState || !verifier) {
    throw new Error("The sign-in response could not be verified. Please try again.");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const response = await fetch(`${domain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error("Cognito could not complete sign-in. Please try again.");
  }

  const tokens = await response.json();
  window.sessionStorage.removeItem(stateKey);
  window.sessionStorage.removeItem(verifierKey);
  window.sessionStorage.setItem(storageKey, JSON.stringify(tokens));
  window.history.replaceState({}, document.title, window.location.pathname);

  return getStoredSession();
}

export function beginSignOut() {
  clearStoredSession();
  if (!isConfigured()) return;

  const parameters = new URLSearchParams({
    client_id: clientId,
    logout_uri: redirectUri,
  });
  window.location.assign(`${domain}/logout?${parameters.toString()}`);
}
