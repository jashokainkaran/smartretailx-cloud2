export default function ImagePlaceholder({ className = "" }) {
  return (
    <div
      className={`flex items-center justify-center bg-stone-100 text-stone-300 ${className}`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="h-10 w-10"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-5-5-4 4-3-3-6 6" />
      </svg>
    </div>
  );
}
