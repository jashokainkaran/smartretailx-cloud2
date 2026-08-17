export default function NavButton({ active, onClick, children, icon, badge }) {
  return (
    <button
      onClick={onClick}
      className={`relative flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium ${active ? "bg-brand-50 text-brand-800" : "text-stone-600 hover:bg-stone-100"}`}
    >
      {icon}
      {children}
      {badge > 0 && (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
