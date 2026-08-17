import { useState } from "react";
import NavButton from "./NavButton.jsx";
import MenuIcon from "./MenuIcon.jsx";

// Deliberately no basket/checkout links here: an admin-only Cognito account
// (not also in the customers group) cannot check out at all — the order
// endpoints require the customers group specifically. Showing shopping
// links an admin account may not even be able to use would be misleading.
export default function AdminNavbar({ route, navigate }) {
  const [open, setOpen] = useState(false);

  function go(target) {
    navigate(target);
    setOpen(false);
  }

  const links = (
    <>
      <NavButton active={route === "dashboard"} onClick={() => go("dashboard")}>Dashboard</NavButton>
      <NavButton active={route === "admin"} onClick={() => go("admin")}>Products</NavButton>
      <NavButton active={route === "customers"} onClick={() => go("customers")}>Customers &amp; orders</NavButton>
      <NavButton active={route === "catalogue"} onClick={() => go("catalogue")}>View store</NavButton>
    </>
  );

  return (
    <>
      <nav className="hidden items-center gap-1 md:flex" aria-label="Administrator navigation">
        {links}
      </nav>

      <button
        onClick={() => setOpen((current) => !current)}
        className="rounded-md p-2 text-stone-600 hover:bg-stone-100 md:hidden"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
      >
        <MenuIcon open={open} />
      </button>

      {open && (
        <nav
          className="absolute inset-x-0 top-full z-10 flex flex-col gap-1 border-b border-stone-200 bg-white p-3 shadow-md md:hidden"
          aria-label="Administrator navigation"
        >
          {links}
        </nav>
      )}
    </>
  );
}
