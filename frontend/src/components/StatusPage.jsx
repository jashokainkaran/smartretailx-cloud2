import StatusIcon from "./StatusIcon.jsx";

const TONES = {
  error: "border-red-100 bg-red-50 text-red-400",
  warning: "border-amber-100 bg-amber-50 text-amber-500",
  neutral: "border-stone-200 bg-stone-50 text-stone-400",
};

const BUTTON_TONES = {
  error: "bg-red-600 hover:bg-red-700",
  warning: "bg-brand-600 hover:bg-brand-700",
  neutral: "bg-brand-600 hover:bg-brand-700",
};

// The shared full-page/card status layout — used by ErrorState (API
// failures), ErrorBoundary (render crashes), AccessDenied, and NotFound, so
// all four read as one consistent design instead of four separately
// styled one-offs.
export default function StatusPage({ variant = "error", tone = "error", title, message, action, compact = false }) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 rounded-xl border text-center ${TONES[tone]} ${compact ? "px-6 py-16" : "px-6 py-24"}`}
    >
      <div className={`flex h-14 w-14 items-center justify-center rounded-full border ${TONES[tone]}`}>
        <StatusIcon variant={variant} />
      </div>
      {title && <h2 className="text-lg font-bold text-stone-900">{title}</h2>}
      <p className="max-w-sm text-sm font-medium text-stone-600">{message}</p>
      {action && (
        <button
          onClick={action.onClick}
          className={`mt-1 rounded-lg px-4 py-2 text-sm font-medium text-white transition ${BUTTON_TONES[tone]}`}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
