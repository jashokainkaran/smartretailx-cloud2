import { motion } from "framer-motion";
import CartIcon from "./CartIcon.jsx";

// Frosted glass rather than a solid fill — it sits quietly translucent
// against the page until touched, then resolves to fully opaque the
// instant it's pressed, as a small confirmation the tap registered right
// before the page navigates away. Mobile only: on desktop the basket is
// already sitting in the top nav at all times, so a second shortcut to the
// same place would just be clutter.
export default function FloatingCartButton({ itemCount, onClick }) {
  return (
    <motion.button
      onClick={onClick}
      initial={{ opacity: 0, y: 16, scale: 0.85 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 16, scale: 0.85 }}
      whileHover={{ opacity: 1, scale: 1.05 }}
      whileTap={{ opacity: 1, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 380, damping: 28 }}
      style={{ opacity: 0.62 }}
      className="fixed bottom-6 right-6 z-20 flex h-14 w-14 items-center justify-center rounded-full border border-white/40 bg-white/40 text-brand-800 shadow-luxe backdrop-blur-md transition-opacity md:hidden"
      aria-label={`Go to basket, ${itemCount} item${itemCount === 1 ? "" : "s"}`}
    >
      <CartIcon className="h-6 w-6" />
      <motion.span
        key={itemCount}
        initial={{ scale: 1.35 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 18 }}
        className="absolute -right-1 -top-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-brand-700 px-1 text-xs font-bold tabular-nums text-white shadow-sm"
      >
        {itemCount > 99 ? "99+" : itemCount}
      </motion.span>
    </motion.button>
  );
}
