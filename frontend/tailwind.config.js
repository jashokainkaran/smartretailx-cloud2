/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // Antique gold — the single accent. Desaturated on purpose so it
        // reads as material (brass/gold leaf) rather than a screen-saturated
        // "brand yellow".
        brand: {
          50: "#fbf7ec",
          100: "#f4e9cc",
          200: "#e8d19d",
          300: "#d8b36a",
          400: "#c89a44",
          500: "#ad7d2e",
          600: "#8c6424",
          700: "#6d4c1e",
          800: "#573e1c",
          900: "#47331b",
        },
        // Warm cream surfaces, a shade above stone-50, used for page
        // background and low-emphasis panels.
        cream: {
          DEFAULT: "#faf6ee",
          50: "#fefcf8",
          100: "#faf6ee",
          200: "#f3ebda",
        },
        // The dedicated "stock urgency" colour — out of stock / low stock —
        // kept separate from red (real errors) and amber (generic warnings)
        // so it means one specific thing wherever it appears.
        persimmon: {
          50: "#fdf1ec",
          100: "#f9dcd0",
          500: "#e2603a",
          600: "#c94f2c",
          700: "#a13e23",
        },
        // A near-black warmed slightly toward plum, used for the site's
        // dark surfaces (the CTA panel, drawer backdrop, modal backdrop)
        // instead of a flat neutral stone-900.
        plum: "#241b23",
      },
      fontFamily: {
        sans: ["Bricolage Grotesque", "ui-sans-serif", "system-ui", "sans-serif"],
        serif: ["Fraunces", "ui-serif", "Georgia", "serif"],
      },
      boxShadow: {
        // Tinted with the gold/espresso hue instead of neutral black, so
        // elevation reads as warm rather than a generic UI-kit shadow.
        luxe: "0 20px 50px -20px rgba(71, 51, 27, 0.35)",
        "luxe-sm": "0 8px 24px -12px rgba(71, 51, 27, 0.3)",
      },
    },
  },
  plugins: [],
};
