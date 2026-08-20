export default function Toast({ message, variant = "success" }) {
  if (!message) return null;
  const isError = variant === "error";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`animate-toast-in fixed right-4 top-20 z-20 flex items-center gap-2 rounded-lg border bg-white px-4 py-3 text-sm font-medium shadow-lg ${
        isError ? "border-red-200 text-red-900" : "border-brand-200 text-stone-900"
      }`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`h-4 w-4 shrink-0 ${isError ? "text-red-600" : "text-brand-600"}`}
      >
        {isError ? (
          <>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </>
        ) : (
          <path d="M20 6 9 17l-5-5" />
        )}
      </svg>
      {message}
    </div>
  );
}
