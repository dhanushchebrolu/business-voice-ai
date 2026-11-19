/**
 * Local browser harness for the customer Calls page: `npm run harness:calls`.
 * Serves the real PlaceCallDialog / CallsHistory components, swapping ONLY the
 * server-function layer for an in-memory fake (fake-outbound-functions.ts) and
 * useServerFn for a pass-through. No database, provider or secrets are used,
 * and nothing here is part of the app build.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("."),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@\/lib\/sarvam-outbound\.functions$/,
        replacement: here("./fake-outbound-functions.ts"),
      },
      { find: /^@tanstack\/react-start$/, replacement: here("./react-start-stub.ts") },
      { find: /^@\//, replacement: `${here("../../src")}/` },
    ],
  },
  server: { port: 5199, strictPort: true, host: "127.0.0.1" },
});
