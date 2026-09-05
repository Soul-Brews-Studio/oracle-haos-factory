import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), react()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4134",
        headers: {
          "X-Ingress-Path": "/local-development",
          "X-Remote-User-Id": "local-development",
        },
      },
    },
  },
});
