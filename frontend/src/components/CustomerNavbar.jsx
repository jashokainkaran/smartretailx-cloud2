import { useState } from "react";
import { Drawer } from "vaul";
import { motion } from "framer-motion";
import NavButton from "./NavButton.jsx";
import MenuIcon from "./MenuIcon.jsx";
import CartIcon from "./CartIcon.jsx";

const drawerLinkVariants = {
  hidden: { opacity: 0, x: 24 },
  visible: (index) => ({
    opacity: 1,
    x: 0,
    transition: { delay: 0.05 * index, duration: 0.25, ease: "easeOut" },
  }),
};

export default function CustomerNavbar({ route, cart, user, navigate, signOut, onSignIn }) {
  const [open, setOpen] = useState(false);
  const itemCount = cart.reduce((total, item) => total + item.quantity, 0);

  function go(target) {
    navigate(target);
    setOpen(false);
  }

  const items = [
    { key: "home", label: "Home" },
    { key: "catalogue", label: "Shop" },
    { key: "cart", label: "Basket", icon: <CartIcon />, badge: itemCount },
    ...(user ? [{ key: "orders", label: "My orders" }] : []),
    ...(user ? [{ key: "profile", label: "My profile" }] : []),
  ];

  return (
    <>
      <nav className="hidden items-center gap-1 md:flex" aria-label="Main navigation">
        {items.map((item) => (
          <NavButton
            key={item.key}
            active={route === item.key}
            onClick={() => go(item.key)}
            icon={item.icon}
            badge={item.badge}
            layoutId="customer-nav-desktop"
          >
            {item.label}
          </NavButton>
        ))}
      </nav>

      <button
        onClick={() => setOpen(true)}
        className="relative rounded-full p-2.5 text-stone-700 transition hover:bg-white md:hidden"
        aria-label="Open menu"
        aria-expanded={open}
      >
        <MenuIcon open={false} />
        {itemCount > 0 && (
          <motion.span
            key={itemCount}
            initial={{ scale: 1.35 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 18 }}
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-700 px-1 text-[10px] font-bold leading-none text-white"
          >
            {itemCount > 99 ? "99+" : itemCount}
          </motion.span>
        )}
      </button>

      {/* dismissible (tap outside / drag closes) and modal are Vaul's
          defaults — no handle, drag works from anywhere on the panel. */}
      <Drawer.Root open={open} onOpenChange={setOpen} direction="right">
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-30 bg-plum/55 backdrop-blur-sm md:hidden" />
          <Drawer.Content
            aria-describedby={undefined}
            className="fixed inset-y-4 right-0 z-40 flex w-[72%] max-w-xs flex-col rounded-l-3xl bg-cream-50 shadow-luxe outline-none md:hidden"
          >
            <div className="flex items-center justify-between border-b border-brand-900/10 px-6 py-5">
              <Drawer.Title className="font-serif text-lg font-semibold text-stone-900">Menu</Drawer.Title>
              <button
                onClick={() => setOpen(false)}
                className="rounded-full p-2 text-stone-600 transition hover:bg-white"
                aria-label="Close menu"
              >
                <MenuIcon open />
              </button>
            </div>
            <ul className="flex flex-1 flex-col gap-1 overflow-y-auto px-4 py-4">
              {items.map((item, index) => (
                <motion.li key={item.key} custom={index} variants={drawerLinkVariants} initial="hidden" animate="visible">
                  <button
                    onClick={() => go(item.key)}
                    className={`flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3.5 text-base font-medium transition ${
                      route === item.key ? "bg-brand-100 text-brand-800" : "text-stone-700 hover:bg-white"
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      {item.icon}
                      {item.label}
                    </span>
                    {item.badge > 0 && (
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-700 px-1.5 text-xs font-bold text-white">
                        {item.badge > 99 ? "99+" : item.badge}
                      </span>
                    )}
                  </button>
                </motion.li>
              ))}
            </ul>
            {user ? (
              <div className="flex items-center justify-between gap-3 border-t border-brand-900/10 px-6 py-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-stone-900">{user.email}</p>
                  <p className="text-xs text-stone-500">Customer</p>
                </div>
                <button
                  onClick={() => { setOpen(false); signOut(); }}
                  className="shrink-0 text-sm font-medium text-stone-500 transition hover:text-stone-800"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <div className="border-t border-brand-900/10 px-6 py-4">
                <button
                  onClick={() => { setOpen(false); onSignIn(); }}
                  className="w-full rounded-full bg-brand-600 px-4 py-3 text-sm font-semibold text-white shadow-luxe-sm transition hover:bg-brand-700"
                >
                  Sign in
                </button>
              </div>
            )}
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  );
}
