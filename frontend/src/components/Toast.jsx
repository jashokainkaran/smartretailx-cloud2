export default function Toast({ message }) {
  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-toast-in fixed right-4 top-20 z-20 flex items-center gap-2 rounded-lg border border-brand-200 bg-white px-4 py-3 text-sm font-medium text-stone-900 shadow-lg"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4 shrink-0 text-brand-600"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
      {message}
    </div>
  );
}
