import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only proxy so the browser can hit the public RPC without CORS.
// In production the Console API serves these paths (the SPA stays origin-relative).
// Override the upstream with VITE_RPC_UPSTREAM in console/.env if needed.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const upstream = env.VITE_RPC_UPSTREAM || "https://rpc.ledger.haratrust.io";
  return {
    plugins: [react()],
    server: {
      port: 5273,
      proxy: {
        // /rpc/read/ -> https://rpc.ledger.haratrust.io/read/
        "/rpc": {
          target: upstream,
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/rpc/, ""),
        },
      },
    },
  };
});
