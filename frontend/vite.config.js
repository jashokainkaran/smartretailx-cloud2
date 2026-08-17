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
  // Vitest reads this same file — jsdom simulates a browser DOM so
  // components can actually render and be queried/clicked in tests without
  // a real browser. setupFiles wires in jest-dom's matchers once globally.
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.js"],
    // "forks" (Vitest's default) spawns separate OS processes for test
    // workers, which timed out trying to start in this environment.
    // "threads" runs workers in-process instead and starts reliably here.
    pool: "threads",
  },
});
