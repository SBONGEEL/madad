import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// publicDir = brand/: شعار واحد وخط واحد للمشروع كله. @ui = مكوّنات نظام التصميم المشتركة بين الواجهات الأربع.
export default defineConfig({
  plugins: [react()],
  publicDir: path.resolve(__dirname, "../brand"),
  resolve: { alias: { "@": path.resolve(__dirname, "src"), "@ui": path.resolve(__dirname, "../ui") } },
  server: {
    host: true,
    port: 5184,
    fs: { allow: [path.resolve(__dirname, "..")] },
    watch: process.env.VITE_POLL ? { usePolling: true, interval: 300 } : undefined,
    proxy: { "/api": { target: process.env.VITE_API_TARGET ?? "http://localhost:8000", changeOrigin: true } },
  },
});
