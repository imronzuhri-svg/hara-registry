import type { Config } from "tailwindcss";

// Strata palette — sourced from doc/design (ic_registry_* SVGs).
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          teal: "#2BD4C0",
          blue: "#3B6BFF",
          indigo: "#5A45E0",
        },
        accent: {
          highlight: "#FFE6B8",
          amber: "#FFC56E",
          gold: "#F39B24",
          orange: "#FF9D5C",
        },
        ink: {
          900: "#070B18", // app background
          800: "#0C1226", // panels
          700: "#101A38", // raised surface / borders
        },
        mist: {
          0: "#FFFFFF",
          1: "#E8ECF6",
          2: "#F4F6FB",
        },
      },
      fontFamily: {
        display: ['"Sora"', "system-ui", "sans-serif"],
        body: ['"Inter"', "system-ui", "sans-serif"],
      },
      backgroundImage: {
        strata: "linear-gradient(135deg, #2BD4C0 0%, #3B6BFF 50%, #5A45E0 100%)",
        "core-glow": "radial-gradient(circle at 50% 50%, #FFC56E 0%, #F39B24 60%, transparent 100%)",
      },
      boxShadow: {
        panel: "0 1px 0 0 rgba(232,236,246,0.04), 0 8px 24px -12px rgba(0,0,0,0.6)",
      },
    },
  },
  plugins: [],
} satisfies Config;
