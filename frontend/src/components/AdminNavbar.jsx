import { useState } from "react";
import { Drawer } from "vaul";
import { motion } from "framer-motion";
import NavButton from "./NavButton.jsx";
import MenuIcon from "./MenuIcon.jsx";

const drawerLinkVariants = {
  hidden: { opacity: 0, x: 24 },
  visible: (index) => ({
    opacity: 1,
    x: 0,
    transition: { delay: 0.05 * index, duration: 0.25, ease: "easeOut" },
  }),
};

function DashboardIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

function ProductsIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M21 8 12 3 3 8l9 5 9-5Z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </svg>
  );
}

function CustomersIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <circle cx="9" cy="8" r="3.25" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.25 3.25 0 0 1 0 6.4" />
      <path d="M18 13.5a6.5 6.5 0 0 1 3.5 5.8" />
    </svg>
  );
}

function StoreIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M3 9 4.5 3.5h15L21 9" />
      <path d="M3 9v11h18V9" />
      <path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" />
      <path d="M9.5 20v-6h5v6" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c1.4-4 4.6-6 8-6s6.6 2 8 6" />
    </svg>
  );
}

// Deliberately no basket/checkout links here: an admin-only Cognito account
// (not also in the customers group) cannot check out at all — the order
// endpoints require the customers group specifically. Showing shopping
// links an admin account may not even be able to use would be misleading.
export default function AdminNavbar({ route, navigate, user, signOut }) {
  const [open, setOpen] = useState(false);

  function go(target) {
    navigate(target);
    setOpen(false);
  }

  const items = [
    { key: "dashboard", label: "Dashboard", icon: <DashboardIcon /> },
    { key: "admin", label: "Products", icon: <ProductsIcon /> },
    { key: "customers", label: "Customers & orders", icon: <CustomersIcon /> },
    { key: "catalogue", label: "View store", icon: <StoreIcon /> },
    { key: "profile", label: "My profile", icon: <ProfileIcon /> },
  ];

  return (
    <>
      <nav className="hidden items-center gap-1 md:flex" aria-label="Administrator navigation">
        {items.map((item) => (
          <NavButton
            key={item.key}
            active={route === item.key}
            onClick={() => go(item.key)}
            icon={item.icon}
            layoutId="admin-nav-desktop"
          >
            {item.label}
          </NavButton>
        ))}
      </nav>

      <button
        onClick={() => setOpen(true)}
        className="rounded-full p-2.5 text-stone-700 transition hover:bg-white md:hidden"
        aria-label="Open menu"
        aria-expanded={open}
      >
        <MenuIcon open={false} />
      </button>

      <Drawer.Root open={open} onOpenChange={setOpen} direction="right">
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-30 bg-plum/55 backdrop-blur-sm md:hidden" />
          <Drawer.Content
            aria-describedby={undefined}
            className="fixed inset-y-4 right-0 z-40 flex w-[72%] max-w-xs flex-col rounded-l-3xl bg-cream-50 shadow-luxe outline-none md:hidden"
          >
            <div className="flex items-center justify-between border-b border-brand-900/10 px-6 py-5">
              <Drawer.Title className="font-serif text-lg font-semibold text-stone-900">Admin menu</Drawer.Title>
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
                    className={`flex w-full items-center gap-2.5 rounded-xl px-4 py-3.5 text-base font-medium transition ${
                      route === item.key ? "bg-brand-100 text-brand-800" : "text-stone-700 hover:bg-white"
                    }`}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                </motion.li>
              ))}
            </ul>
            {user && (
              <div className="flex items-center justify-between gap-3 border-t border-brand-900/10 px-6 py-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-stone-900">{user.email}</p>
                  <p className="text-xs text-stone-500">Administrator</p>
                </div>
                <button
                  onClick={() => { setOpen(false); signOut(); }}
                  className="shrink-0 text-sm font-medium text-stone-500 transition hover:text-stone-800"
                >
                  Sign out
                </button>
              </div>
            )}
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  );
}
