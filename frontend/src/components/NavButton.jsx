import { motion } from "framer-motion";

// layoutId is optional and opt-in per nav instance (see CustomerNavbar's
// desktop list) — passing the SAME layoutId to two NavButtons that could be
// mounted at once (e.g. the desktop list and an always-in-DOM mobile list)
// would fight over one shared layout animation, so callers give each
// simultaneously-mounted list its own id rather than sharing one globally.
export default function NavButton({ active, onClick, children, icon, badge, layoutId }) {
  return (
    <button
      onClick={onClick}
      className={`relative flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium transition-colors ${
        active ? "text-brand-800" : "text-stone-600 hover:text-stone-900"
      }`}
    >
      {active && (
        layoutId ? (
          <motion.span
            layoutId={layoutId}
            className="absolute inset-0 rounded-full bg-brand-100"
            transition={{ type: "spring", stiffness: 400, damping: 32 }}
          />
        ) : (
          <span className="absolute inset-0 rounded-full bg-brand-100" />
        )
      )}
      <span className="relative flex items-center gap-1.5">
        {icon}
        {children}
      </span>
      {badge > 0 && (
        <motion.span
          key={badge}
          initial={{ scale: 1.35 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 18 }}
          className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-700 px-1 text-[10px] font-bold leading-none text-white"
        >
          {badge > 99 ? "99+" : badge}
        </motion.span>
      )}
    </button>
  );
}
