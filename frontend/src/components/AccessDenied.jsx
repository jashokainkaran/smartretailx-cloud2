import StatusPage from "./StatusPage.jsx";

// Two distinct cases share this one guarded-route fallback, and they need
// different copy: someone with no session yet just needs to sign in, but a
// signed-in customer landing on an admin-only route already IS signed in —
// telling them to "sign in" again would be actively misleading. `user`
// tells these apart.
export default function AccessDenied({ user, onSignIn, onGoHome }) {
  if (user) {
    return (
      <StatusPage
        variant="forbidden"
        tone="error"
        title="Unauthorized"
        message="Your account doesn't have access to this area."
        action={{ label: "Back to store", onClick: onGoHome }}
      />
    );
  }
  return (
    <StatusPage
      variant="lock"
      tone="warning"
      title="Sign-in required"
      message="Please sign in to access this area."
      action={{ label: "Sign in", onClick: onSignIn }}
    />
  );
}
