/**
 * Local browser harness for the customer's provisioning status (see
 * fake-supabase.ts). The REAL AccountStatusPanel is rendered where the app
 * renders it: the dashboard (#/app, showChannels false) and billing
 * (#/app/billing). The harness bar only moves the simulated backend between
 * provisioning stages, as the pipeline and the ClickAI team would; the panel
 * re-reads it through the real queries. Not part of the app build.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import "@/styles.css";
import { Toaster } from "@/components/ui/sonner";
import { AccountStatusPanel } from "@/components/app/AccountStatusPanel";
import { STAGES, currentStage, setStage } from "./stages";

function useHash() {
  const [hash, setHash] = useState(location.hash || "#/app");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/app");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function HarnessBar() {
  const qc = useQueryClient();
  const [stage, set] = useState(currentStage().id);
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-border p-3 text-xs"
      data-testid="harness-bar"
    >
      <span className="font-medium">Simulated backend:</span>
      <select
        aria-label="Simulated provisioning stage"
        className="rounded border border-border bg-background p-1"
        value={stage}
        onChange={(e) => {
          setStage(e.target.value);
          set(e.target.value);
          // What a refetch after a backend change does in the app.
          void qc.invalidateQueries();
        }}
      >
        {STAGES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function App() {
  const hash = useHash();
  const billing = hash === "#/app/billing";
  return (
    <>
      <HarnessBar />
      <nav className="flex gap-4 p-4 text-sm" aria-label="App">
        <a href="#/app" aria-current={!billing ? "page" : undefined}>
          Dashboard
        </a>
        <a href="#/app/billing" aria-current={billing ? "page" : undefined}>
          Billing
        </a>
      </nav>
      <main
        className="mx-auto max-w-5xl space-y-6 p-4"
        data-page={billing ? "billing" : "dashboard"}
      >
        <h1 className="text-lg font-semibold">{billing ? "Billing" : "Dashboard"}</h1>
        {billing ? <AccountStatusPanel /> : <AccountStatusPanel showChannels={false} />}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <App />
      <Toaster position="top-right" />
    </QueryClientProvider>
  </StrictMode>,
);
