import { motion } from "framer-motion";

// The one shared "it worked" treatment for every success confirmation in
// the app (profile saved, password changed, MFA enabled, basket prices
// refreshed, and so on) — a slide-down entrance plus a checkmark that
// actually draws itself on, rather than each page inventing its own flat
// static banner. className is for margin only; the notice's own look
// (border, fill, text colour) stays fixed so every instance reads as the
// same voice.
export default function SuccessNotice({ children, className = "" }) {
  return (
    <motion.p
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      role="status"
      className={`flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 ${className}`}
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600">
        <motion.circle
          cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.4, ease: "easeOut" }}
        />
        <motion.path
          d="m8 12 3 3 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.3, delay: 0.35, ease: "easeOut" }}
        />
      </svg>
      <span>{children}</span>
    </motion.p>
  );
}
