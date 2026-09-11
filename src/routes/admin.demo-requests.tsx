import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Inbox, ArrowRight } from "lucide-react";
import {
  listDemoRequests,
  updateDemoRequestStatus,
  updateDemoRequestNotes,
  DEMO_REQUEST_STATUSES,
  type DemoRequestStatus,
} from "@/lib/admin-demo-requests.functions";
import {
  PageHeader,
  LoadingState,
  ErrorState,
  EmptyState,
  StatusPill,
} from "@/components/app/primitives";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/admin/demo-requests")({
  head: () => ({
    meta: [{ title: "Demo requests — Klyro Control" }],
  }),
  component: AdminDemoRequests,
});

const STATUS_TONE: Record<DemoRequestStatus, "info" | "ready" | "accent" | "live" | "idle"> = {
  NEW: "info",
  CONTACTED: "ready",
  DEMO_SCHEDULED: "accent",
  WON: "live",
  LOST: "idle",
};

function NotesEditor({ id, initial }: { id: string; initial: string | null }) {
  const [value, setValue] = useState(initial ?? "");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = useServerFn(updateDemoRequestNotes);
  const queryClient = useQueryClient();

  if (!editing) {
    return (
      <button
        type="button"
        className="max-w-[220px] truncate text-left text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setEditing(true)}
        title={initial ?? "Add internal notes"}
      >
        {initial?.trim() ? initial : "Add notes…"}
      </button>
    );
  }

  return (
    <div className="space-y-1.5" style={{ minWidth: 220 }}>
      <Textarea
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="text-xs"
        autoFocus
      />
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await save({ data: { id, notes: value } });
              await queryClient.invalidateQueries({ queryKey: ["admin-demo-requests"] });
              setEditing(false);
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "Could not save notes");
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          disabled={busy}
          onClick={() => {
            setValue(initial ?? "");
            setEditing(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AdminDemoRequests() {
  const fetchRequests = useServerFn(listDemoRequests);
  const setStatus = useServerFn(updateDemoRequestStatus);
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<DemoRequestStatus | "all">("all");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-demo-requests"],
    queryFn: () => fetchRequests({ data: {} }),
  });

  const rows = (data ?? []).filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return [r.name, r.email, r.business_name, r.phone].some((v) => v?.toLowerCase().includes(term));
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Demo requests"
        description="Every 'Book a demo' submission from the public site. Convert a WON lead into a provisioned customer without retyping their details."
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          placeholder="Search name, email, business or phone"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-sm"
        />
        <div className="flex flex-wrap gap-1.5">
          {(["all", ...DEMO_REQUEST_STATUSES] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-full border px-3 py-1 text-xs capitalize transition-colors ${
                statusFilter === s
                  ? "border-primary/40 bg-primary/12 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {s.replace(/_/g, " ").toLowerCase()}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <LoadingState label="Loading demo requests" />
      ) : error ? (
        <ErrorState
          message={error instanceof Error ? error.message : "Could not load demo requests"}
          onRetry={() => void refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No demo requests match"
          description="Submissions from the public 'Book a demo' form will appear here."
        />
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Business</th>
                <th className="px-3 py-2.5 font-medium">Email</th>
                <th className="px-3 py-2.5 font-medium">Phone</th>
                <th className="px-3 py-2.5 font-medium">Message</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Notes</th>
                <th className="px-3 py-2.5 font-medium">Received</th>
                <th className="px-4 py-2.5 font-medium">Customer</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60 align-top hover:bg-muted/40">
                  <td className="px-4 py-2.5 font-medium">{r.name}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{r.business_name ?? "—"}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{r.email}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                    {r.phone ?? "—"}
                  </td>
                  <td
                    className="max-w-[220px] truncate px-3 py-2.5 text-xs text-muted-foreground"
                    title={r.message ?? ""}
                  >
                    {r.message ?? "—"}
                  </td>
                  <td className="px-3 py-2.5">
                    <Select
                      value={r.status}
                      onValueChange={async (value) => {
                        try {
                          await setStatus({
                            data: { id: r.id, status: value as DemoRequestStatus },
                          });
                          await queryClient.invalidateQueries({
                            queryKey: ["admin-demo-requests"],
                          });
                        } catch (error) {
                          toast.error(
                            error instanceof Error ? error.message : "Could not update status",
                          );
                        }
                      }}
                    >
                      <SelectTrigger className="h-8 w-[150px] text-xs">
                        <StatusPill tone={STATUS_TONE[r.status]} dot={false}>
                          <SelectValue />
                        </StatusPill>
                      </SelectTrigger>
                      <SelectContent>
                        {DEMO_REQUEST_STATUSES.map((s) => (
                          <SelectItem key={s} value={s} className="text-xs">
                            {s.replace(/_/g, " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-2.5">
                    <NotesEditor id={r.id} initial={r.admin_notes} />
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground tabular">
                    {new Date(r.created_at).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.converted && r.organization ? (
                      <Link
                        to="/admin/customers/$orgId"
                        params={{ orgId: r.organization.id }}
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        {r.organization.client_id} <ArrowRight className="size-3" />
                      </Link>
                    ) : r.status === "WON" ? (
                      <Link
                        to="/admin/customers"
                        search={{
                          status: "all",
                          demoRequestId: r.id,
                          prefillName: r.name,
                          prefillBusiness: r.business_name ?? "",
                          prefillEmail: r.email,
                          prefillPhone: r.phone ?? "",
                        }}
                      >
                        <Button size="sm" variant="outline" className="h-7 text-xs">
                          Create customer
                        </Button>
                      </Link>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
