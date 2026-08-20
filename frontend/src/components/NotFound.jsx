import StatusPage from "./StatusPage.jsx";

export default function NotFound({ onGoHome }) {
  return (
    <StatusPage
      variant="compass"
      tone="neutral"
      title="Page not found"
      message="That page doesn't exist, or the link may be out of date."
      action={{ label: "Back to home", onClick: onGoHome }}
    />
  );
}
