/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/renderer/index.html", "./src/renderer/src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Brand accent (arancione caldo, identico in dark e light).
        accent: {
          DEFAULT: "#ff7c3c",
          hover: "#ff8f5a",
          soft: "rgba(255, 124, 60, 0.12)",
          softHover: "rgba(255, 124, 60, 0.20)",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      borderRadius: {
        xl: "0.875rem", // 14px — card radius standard del template
      },
    },
  },
  plugins: [],
};
