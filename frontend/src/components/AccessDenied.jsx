import StatusPage from "./StatusPage.jsx";

export default function AccessDenied({ onSignIn }) {
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
