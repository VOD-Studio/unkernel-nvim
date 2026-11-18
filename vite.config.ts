import { defineConfig } from "vite";

const crossOriginHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: {
    port: 5173,
    headers: crossOriginHeaders,
  },
  preview: {
    port: 4173,
    headers: crossOriginHeaders,
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["unkernel"],
  },
  build: {
    target: "esnext",
  },
});
