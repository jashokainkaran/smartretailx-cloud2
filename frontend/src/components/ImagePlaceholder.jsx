export default function ImagePlaceholder({ className = "" }) {
  return (
    <div
      className={`flex items-center justify-center bg-cream-200 text-brand-300 ${className}`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        className="h-9 w-9"
      >
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <circle cx="9" cy="9" r="1.75" />
        <path d="m21 15-5-5-4 4-3-3-6 6" />
      </svg>
    </div>
  );
}
