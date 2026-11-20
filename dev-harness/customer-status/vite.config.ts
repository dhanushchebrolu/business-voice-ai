/**
 * Local browser harness for the customer's provisioning status:
 * `npm run harness:customer-status`. Serves the real AccountStatusPanel and
 * the real workspace queries; only the Supabase client, auth, checkout,
 * billing flag and router Link are swapped for fakes. Not part of the app build.
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
      { find: /^@\/integrations\/supabase\/client$/, replacement: here("./fake-supabase.ts") },
      {
        find: /^@\/(hooks\/useAuth|hooks\/useCheckout|lib\/billing\.functions)$/,
        replacement: here("./fakes.tsx"),
      },
      { find: /^@tanstack\/react-router$/, replacement: here("./fakes.tsx") },
      { find: /^@tanstack\/react-start$/, replacement: here("../calls/react-start-stub.ts") },
      { find: /^@\//, replacement: `${here("../../src")}/` },
    ],
  },
  server: { port: 5197, strictPort: true, host: "127.0.0.1" },
});
