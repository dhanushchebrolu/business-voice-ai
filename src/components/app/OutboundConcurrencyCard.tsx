import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getOutboundConcurrency,
  setOutboundConcurrency,
} from "@/lib/outbound-concurrency.functions";
import { EXPLANATION } from "@/lib/outbound-concurrency";
import { describeQueryError } from "@/lib/query-error";
import { ErrorState, LoadingState, SectionCard } from "./primitives";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

function Fact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/**
 * The workspace's outbound concurrency: how many outbound calls may run at once, with the rest
 * of ClickAI's capacity kept for incoming calls. Shared by every campaign of the workspace.
 * The database enforces it; this only chooses and shows it.
 */
export function OutboundConcurrencyCard({ organizationId }: { organizationId: string }) {
  const qc = useQueryClient();
  const key = ["outbound-concurrency", organizationId];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => getOutboundConcurrency({ data: { organizationId } }),
    refetchInterval: 10_000,
  });
  const [saving, setSaving] = useState(false);

  if (isLoading) return <LoadingState />;
  if (error || !data) return <ErrorState message={describeQueryError(error)} />;

  const change = async (value: string) => {
    setSaving(true);
    try {
      const saved = await setOutboundConcurrency({
        data: { organizationId, value: Number(value) },
      });
      qc.setQueryData(key, saved.state);
      toast.success(`Outbound calls limited to ${saved.state.cap} at a time.`);
      if (saved.note) toast.info(saved.note);
    } catch (e) {
      toast.error(describeQueryError(e));
    } finally {
      setSaving(false);
    }
  };

  const waiting = data.remaining === 0 && data.activeOutbound >= data.cap;
  return (
    <SectionCard title="Outbound concurrency" description={EXPLANATION}>
      <div className="space-y-1.5">
        <Label htmlFor="outbound-concurrency">Simultaneous outbound calls</Label>
        <Select value={String(data.cap)} onValueChange={change} disabled={saving}>
          <SelectTrigger id="outbound-concurrency" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {data.options.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
                {data.selected === null && n === data.defaultValue ? " (default)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Selected: {data.cap} of {data.slotLimit} total simultaneous calls. Applies to all your
          campaigns together.
        </p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Outbound limit" value={data.cap} />
        <Fact label="Reserved for incoming" value={data.reservedInbound} />
        <Fact label="Outbound calls now" value={data.activeOutbound} />
        <Fact label="Outbound slots free" value={data.remaining} />
      </div>
      {waiting ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {data.activeOutbound > data.cap
            ? "More calls are running than your new limit. They will finish normally; new calls wait until fewer than the limit are running."
            : "At your limit: the next contact is called as soon as a call finishes."}
        </p>
      ) : data.globalInUse >= data.slotLimit ? (
        <p className="mt-3 text-xs text-muted-foreground">
          ClickAI is at its total call capacity right now; the next call starts when one finishes.
        </p>
      ) : null}
    </SectionCard>
  );
}
