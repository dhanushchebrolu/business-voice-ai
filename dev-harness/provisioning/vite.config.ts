/**
 * Local browser harness for the admin Outbound agent panel:
 * `npm run harness:provisioning`. Serves the real OutboundAgentPanel,
 * swapping ONLY its server functions for in-memory fakes (fake-functions.ts)
 * and useServerFn for a pass-through. Not part of the app build.
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
        find: /^@\/lib\/(sarvam-integration|provisioning-admin)\.functions$/,
        replacement: here("./fake-functions.ts"),
      },
      { find: /^@tanstack\/react-start$/, replacement: here("../calls/react-start-stub.ts") },
      { find: /^@\//, replacement: `${here("../../src")}/` },
    ],
  },
  server: { port: 5198, strictPort: true, host: "127.0.0.1" },
});
