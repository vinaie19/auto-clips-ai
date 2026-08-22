import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Vite 8 (rolldown) derives the oxc parser `lang` from the file extension,
  // so `.js` is parsed with JSX disabled. Scope an explicit `jsx` lang to
  // JS-family files so `.js` components containing JSX transform correctly.
  oxc: {
    lang: "jsx",
    include: /\.jsx?$/,
    exclude: /node_modules/,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["__tests__/**/*.test.{js,jsx}"],
  },
});