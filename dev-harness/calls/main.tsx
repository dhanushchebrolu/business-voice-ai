/**
 * Local browser harness for the customer Calls page (see fake-outbound-functions.ts).
 * Renders the real PlaceCallButton and CallsHistory with the same refresh rule
 * as src/routes/app.calls.tsx. Not part of the app build.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import "@/styles.css";
import { Toaster } from "@/components/ui/sonner";
import { PageHeader } from "@/components/app/primitives";
import { Input } from "@/components/ui/input";
import { PlaceCallButton } from "@/components/app/PlaceCallDialog";
import { CallsHistory } from "@/components/app/CallsHistory";
import { isCallOpen } from "@/lib/call-history";
import { listCalls } from "./fake-outbound-functions";

function HarnessCallsPage() {
  const organizationId = "org_demo";
  const { data: calls, isLoading } = useQuery({
    queryKey: ["calls", organizationId],
    queryFn: listCalls,
    refetchInterval: (query) =>
      (query.state.data ?? []).some((c) => isCallOpen(c.status)) ? 2_000 : false,
  });
  const [q, setQ] = useState("");
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      <PageHeader
        title="Calls"
        description="Every call your receptionist handled or placed, with duration, language, outcome and full transcript."
        actions={
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <PlaceCallButton organizationId={organizationId} />
            <div className="relative min-w-0 flex-1 sm:flex-none">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search calls"
                className="h-9 w-full pl-8 sm:w-56"
              />
            </div>
          </div>
        }
      />
      <CallsHistory calls={calls} isLoading={isLoading} query={q} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <HarnessCallsPage />
      <Toaster position="top-right" />
    </QueryClientProvider>
  </StrictMode>,
);
