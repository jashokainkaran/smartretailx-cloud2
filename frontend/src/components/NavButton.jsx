export default function NavButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-2 text-sm font-medium ${active ? "bg-brand-50 text-brand-800" : "text-stone-600 hover:bg-stone-100"}`}
    >
      {children}
    </button>
  );
}
