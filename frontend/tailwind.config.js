/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f4f7f5",
          100: "#e6ede8",
          200: "#c9d9cf",
          300: "#a1bcaa",
          400: "#729a80",
          500: "#4f7d5f",
          600: "#3c634a",
          700: "#324f3d",
          800: "#2a4033",
          900: "#24352b",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        serif: ["\"Playfair Display\"", "ui-serif", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};
