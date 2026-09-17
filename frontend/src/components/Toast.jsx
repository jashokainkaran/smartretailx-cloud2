import { AnimatePresence, motion } from "framer-motion";

// toastKey (not React's own "key" prop) drives which toast AnimatePresence
// treats as new — the App.jsx caller passes its own toast.key here rather
// than as a component key, because keying the whole component would remount
// it and skip the exit animation instead of playing it.
export default function Toast({ message, variant = "success", toastKey }) {
  const isError = variant === "error";
  return (
    <div className="pointer-events-none fixed right-4 top-20 z-20">
      <AnimatePresence>
        {message && (
          <motion.div
            key={toastKey}
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: -12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
            className={`pointer-events-auto flex items-center gap-2 rounded-xl border bg-white px-4 py-3 text-sm font-medium shadow-luxe ${
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
