import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "ui-monospace", "monospace"],
      },
      colors: {
        navy: "#0A2240",
        red: "#C0392B",
        teal: "#1ABC9C",
        amber: "#F39C12",
        background: "#F7F8F9",
        surface: "#FFFFFF",
        border: "#E0E6ED",
        "border-subtle": "rgba(26,39,68,0.08)",
        text: "#1A2744",
        "text-secondary": "#5B6B8C",
        muted: "#8A95AB",
        blue: "#2980B9",
        purple: "#8E44AD",
        grey: "#95A5A6",
        // Status tokens mapped 1:1 onto the Excel export's own color legend
        // (CLAUDE.md) so the review UI and the file an analyst downloads read
        // as the same system, not two different visual languages.
        "state-ai-high": { fill: "#D6EAF8", text: "#3498DB" },
        "state-override": { fill: "#FDEBD0", text: "#E67E22" },
        "state-added": { fill: "#D5F5E3", text: "#27AE60" },
        "state-low-conf": { fill: "#FEF9E7", text: "#B7791F" },
        "state-missing": { fill: "#FADBD8", text: "#C0392B" },
        "state-web": { fill: "#EBF5FB", text: "#3D5A80" },
      },
      transitionTimingFunction: {
        "entrance": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
};
export default config;
