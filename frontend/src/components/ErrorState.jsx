import StatusPage from "./StatusPage.jsx";

export default function ErrorState({ message, onRetry }) {
  return (
    <StatusPage
      variant="error"
      tone="error"
      message={message || "Something went wrong talking to the API."}
      action={onRetry ? { label: "Try again", onClick: onRetry } : null}
    />
  );
}
