import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
  },
  server: {
    port: 5190,
    proxy: {
      "/api": "http://localhost:3847",
      "/ws": { target: "ws://localhost:3847", ws: true },
    },
  },
});
