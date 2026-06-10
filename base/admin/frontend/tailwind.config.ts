import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        sidebar: {
          DEFAULT: "var(--color-sidebar-bg)",
          hover: "var(--color-sidebar-hover)",
          active: "var(--color-sidebar-active)",
        },
        canvas: {
          DEFAULT: "var(--color-bg-primary)",
          secondary: "var(--color-bg-secondary)",
          tertiary: "var(--color-bg-tertiary)",
        },
        surface: {
          card: "var(--color-surface-card)",
          hover: "var(--color-surface-hover)",
          active: "var(--color-surface-active)",
        },
        fg: {
          primary: "var(--color-text-primary)",
          secondary: "var(--color-text-secondary)",
          tertiary: "var(--color-text-tertiary)",
          link: "var(--color-text-link)",
        },
        line: {
          DEFAULT: "var(--color-border-default)",
          subtle: "var(--color-border-subtle)",
        },
        accent: {
          DEFAULT: "var(--color-accent)",
          hover: "var(--color-accent-hover)",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
