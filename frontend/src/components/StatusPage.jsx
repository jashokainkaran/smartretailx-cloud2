import { motion } from "framer-motion";
import StatusIcon from "./StatusIcon.jsx";

const TONES = {
  error: "border-red-100 bg-red-50 text-red-400",
  warning: "border-amber-100 bg-amber-50 text-amber-500",
  neutral: "border-brand-200 bg-cream-100 text-brand-400",
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
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className={`flex flex-col items-center justify-center gap-3 rounded-2xl border text-center ${TONES[tone]} ${compact ? "px-6 py-16" : "px-6 py-24"}`}
    >
      <div className={`flex h-14 w-14 items-center justify-center rounded-full border bg-white/60 ${TONES[tone]}`}>
        <StatusIcon variant={variant} />
      </div>
      {title && <h2 className="font-serif text-xl font-semibold text-stone-900">{title}</h2>}
      <p className="max-w-sm text-sm font-medium text-stone-600">{message}</p>
      {action && (
        <button
          onClick={action.onClick}
          className={`mt-1 rounded-full px-5 py-2.5 text-sm font-semibold text-white shadow-luxe-sm transition hover:-translate-y-0.5 active:translate-y-0 ${BUTTON_TONES[tone]}`}
        >
          {action.label}
        </button>
      )}
    </motion.div>
  );
}
