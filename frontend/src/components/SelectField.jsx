import * as Select from "@radix-ui/react-select";

function ChevronIcon({ direction = "down" }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0">
      <path d={direction === "up" ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// A generic version of CartPage's country SelectField, without the
// per-option flag icon — for any closed-set admin dropdown (delivery
// status, and similar) that would otherwise fall back to a native
// <select> that looks like a different app next to the rest of the UI.
export default function SelectField({ label, value, onChange, options, placeholder, ariaLabel, formatOption }) {
  const display = formatOption || ((option) => option);
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger
        aria-label={ariaLabel || label}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-stone-300 bg-white px-3 py-2 text-left text-sm transition focus:outline-none focus:ring-2 focus:ring-brand-200"
      >
        <Select.Value placeholder={placeholder} className={value ? "text-stone-900" : "text-stone-400"} />
        <Select.Icon>
          <ChevronIcon />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content position="popper" sideOffset={4} className="z-50 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-luxe">
          <Select.ScrollUpButton className="flex items-center justify-center py-1 text-stone-400">
            <ChevronIcon direction="up" />
          </Select.ScrollUpButton>
          <Select.Viewport className="max-h-64 p-1" style={{ width: "var(--radix-select-trigger-width)" }}>
            {options.map((option) => (
              <Select.Item
                key={option}
                value={option}
                className="relative flex cursor-pointer select-none items-center rounded-md py-2 pl-3 pr-8 text-sm text-stone-700 outline-none transition data-[highlighted]:bg-brand-50 data-[highlighted]:text-brand-800"
              >
                <Select.ItemText>{display(option)}</Select.ItemText>
                <Select.ItemIndicator className="absolute right-3 flex items-center text-brand-600">
                  <CheckIcon />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton className="flex items-center justify-center py-1 text-stone-400">
            <ChevronIcon direction="down" />
          </Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
