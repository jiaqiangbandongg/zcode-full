import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5187,
  },
  preview: {
    host: "127.0.0.1",
    port: 5187,
  },
  build: {
    emptyOutDir: true,
    outDir: "dist",
  },
});
