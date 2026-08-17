import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Pin the local hot-reload socket to the same localhost address the
  // Cognito callback uses. This is development tooling only; it is not
  // included in the production build or related to the AWS WebSocket work.
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    hmr: { host: "localhost", port: 5173 },
  },
});
