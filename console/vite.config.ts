import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy /api -> the local Console API (read-only aggregator).
// Run the API alongside: `pnpm --dir server start` (defaults to :8910).
// In production the SPA + API are served same-origin, so no proxy is needed.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const apiUpstream = env.VITE_API_UPSTREAM || "http://localhost:8910";
  return {
    plugins: [react()],
    server: {
      port: 5273,
      proxy: {
        "/api": { target: apiUpstream, changeOrigin: true },
      },
    },
  };
});
