import { useState } from "react";
import NavButton from "./NavButton.jsx";
import MenuIcon from "./MenuIcon.jsx";
import CartIcon from "./CartIcon.jsx";

export default function CustomerNavbar({ route, cart, user, navigate }) {
  const [open, setOpen] = useState(false);
  const itemCount = cart.reduce((total, item) => total + item.quantity, 0);

  function go(target) {
    navigate(target);
    setOpen(false);
  }

  const links = (
    <>
      <NavButton active={route === "catalogue"} onClick={() => go("catalogue")}>Shop</NavButton>
      <NavButton active={route === "cart"} onClick={() => go("cart")} icon={<CartIcon />} badge={itemCount}>Basket</NavButton>
      {user && <NavButton active={route === "orders"} onClick={() => go("orders")}>My orders</NavButton>}
    </>
  );

  return (
    <>
      <nav className="hidden items-center gap-1 md:flex" aria-label="Main navigation">
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
          aria-label="Main navigation"
        >
          {links}
        </nav>
      )}
    </>
  );
}
