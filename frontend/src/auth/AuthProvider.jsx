import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  beginSignIn,
  beginSignOut,
  completeSignIn,
  configurationError,
  getStoredSession,
  isAuthenticationCallback,
  isConfigured,
} from "./cognito.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => getStoredSession());
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const callbackHandled = useRef(false);

  useEffect(() => {
    async function restoreOrCompleteSession() {
      if (!isConfigured()) {
        setError(configurationError());
        setStatus("ready");
        return;
      }

      if (isAuthenticationCallback()) {
        // React Strict Mode re-runs effects in development. A code can only be
        // exchanged once, so this guard prevents a duplicate token request.
        if (callbackHandled.current) return;
        callbackHandled.current = true;

        try {
          const newSession = await completeSignIn();
          setSession(newSession);
        } catch (callbackError) {
          setError(callbackError.message);
        }
      }

      setStatus("ready");
    }

    restoreOrCompleteSession();
  }, []);

  useEffect(() => {
    // Fired by api/http.js the moment any request reveals the token is
    // dead — clears the session so the header/routes reflect it immediately
    // instead of waiting for a page reload to notice.
    function handleSessionExpired() {
      setSession(null);
    }
    window.addEventListener("smartretailx:session-expired", handleSessionExpired);
    return () => window.removeEventListener("smartretailx:session-expired", handleSessionExpired);
  }, []);

  const value = {
    status,
    error,
    user: session?.user ?? null,
    // The HTTP API authorizer's configured audience is the Cognito app
    // client. The ID token has that client ID in its `aud` claim and also
    // carries the signed-in user's group membership for service-side RBAC —
    // an OAuth access token does NOT carry group membership, so it cannot
    // be used here. Named idToken (not accessToken) deliberately, so this
    // is never mistaken for the OAuth-conventional choice.
    idToken: session?.tokens.id_token ?? null,
    isAdmin: session?.user.groups.includes("admin") ?? false,
    signIn: beginSignIn,
    signOut: beginSignOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider.");
  return context;
}
