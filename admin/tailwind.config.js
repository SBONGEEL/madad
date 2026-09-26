import preset from "../ui/tailwind.preset.js";

export default {
  presets: [preset],
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../ui/**/*.{ts,tsx}"],
  plugins: [],
};
