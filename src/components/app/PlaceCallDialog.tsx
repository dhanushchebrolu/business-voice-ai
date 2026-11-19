import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, PhoneOutgoing } from "lucide-react";
import { toast } from "sonner";
import {
  createSarvamInstantOutboundCall,
  getOutboundCallingStatus,
} from "@/lib/sarvam-outbound.functions";
import { normalizeCustomerPhone } from "@/lib/phone-number";
import { formatMoney } from "@/lib/pricing";
import { newRequestKey, REQUEST_KEY_SPENT_MESSAGE } from "@/lib/request-key";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const OBJECTIVE_MAX = 300;

/**
 * "Call a number": one real, billed outbound call by the customer's own
 * assistant. Shown only when the workspace has a Sarvam number. Every check
 * shown here is a preview; the server re-checks all of them when dialling.
 */
export function PlaceCallButton({ organizationId }: { organizationId: string }) {
  const fetchStatus = useServerFn(getOutboundCallingStatus);
  const placeCall = useServerFn(createSarvamInstantOutboundCall);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [numberId, setNumberId] = useState("");
  const [destination, setDestination] = useState("");
  const [objective, setObjective] = useState("");
  const [placing, setPlacing] = useState(false);
  // The last failure, shown in the dialog too (a toast alone is easy to miss).
  const [lastError, setLastError] = useState<string | null>(null);
  // Synchronous guard: a second click before React re-renders never sends a second request.
  const submitting = useRef(false);
  // One request id per attempt at one number, reused for retries (the server dedupes it).
  const attempt = useRef<{ key: string; to: string } | null>(null);

  const statusQuery = useQuery({
    queryKey: ["outbound-calling-status", organizationId],
    queryFn: () => fetchStatus({ data: { orgId: organizationId } }),
    staleTime: 15_000,
  });
  const status = statusQuery.data;
  if (!status || status.numbers.length === 0) return null;

  const selected = status.numbers.find((n) => n.id === numberId) ?? status.numbers[0]!;
  const blockers = [
    ...(status.canDial ? [] : ["Only a workspace owner or admin can place calls."]),
    ...status.blockers,
    ...selected.blockers,
  ];
  const toE164 = normalizeCustomerPhone(destination, null);
  const canSubmit = blockers.length === 0 && Boolean(toE164) && !placing;

  const submit = async () => {
    if (!toE164 || submitting.current) return;
    submitting.current = true;
    if (attempt.current?.to !== toE164) attempt.current = { key: newRequestKey(), to: toE164 };
    setPlacing(true);
    try {
      const result = await placeCall({
        data: {
          phoneNumberId: selected.id,
          toE164,
          objective: objective.trim() || undefined,
          idempotencyKey: attempt.current.key,
        },
      });
      attempt.current = null;
      setLastError(null);
      if (result.duplicate)
        toast.info("Already calling", {
          description: "This call was already placed. It is in your call history.",
        });
      else if (result.outcome === "unknown")
        toast.warning("Call not confirmed", {
          description:
            "We couldn't confirm whether the call started. It shows as unconfirmed in your call history until we know, and you won't be charged twice.",
        });
      else
        toast.success(`Calling ${toE164}`, { description: "It will appear in your calls below." });
      setOpen(false);
      setDestination("");
      setObjective("");
    } catch (err) {
      const message = (err as Error).message;
      // That attempt was not placed; the next try is a new attempt.
      if (message === REQUEST_KEY_SPENT_MESSAGE) attempt.current = null;
      setLastError(message);
      toast.error("Call not placed", { description: message });
    } finally {
      submitting.current = false;
      setPlacing(false);
      void queryClient.invalidateQueries({ queryKey: ["calls", organizationId] });
      void queryClient.invalidateQueries({
        queryKey: ["outbound-calling-status", organizationId],
      });
    }
  };

  return (
    <>
      <Button
        size="sm"
        className="h-9"
        onClick={() => {
          setLastError(null);
          setOpen(true);
        }}
      >
        <PhoneOutgoing className="size-3.5" />
        Call a number
      </Button>
      <Dialog open={open} onOpenChange={(next) => !placing && setOpen(next)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Call a number</DialogTitle>
            <DialogDescription>
              Your assistant calls this person now, introduces itself and handles the conversation.
              People who ask not to be called again are added to your do-not-call list
              automatically.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {status.numbers.length > 1 ? (
              <div className="space-y-1.5">
                <Label htmlFor="place-call-from">Call from</Label>
                <Select value={selected.id} onValueChange={setNumberId} disabled={placing}>
                  <SelectTrigger id="place-call-from">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {status.numbers.map((n) => (
                      <SelectItem key={n.id} value={n.id}>
                        {n.displayNumber ?? n.e164}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Calls from {selected.displayNumber ?? selected.e164}
              </p>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="place-call-to">Number to call</Label>
              <Input
                id="place-call-to"
                inputMode="tel"
                autoComplete="off"
                placeholder="+91 98765 43210"
                value={destination}
                disabled={placing}
                onChange={(e) => {
                  setDestination(e.target.value);
                  setLastError(null);
                }}
                aria-invalid={destination.trim() !== "" && !toE164}
                aria-describedby="place-call-to-hint"
              />
              <p id="place-call-to-hint" className="text-xs text-muted-foreground">
                {destination.trim() !== "" && !toE164
                  ? "Enter the full number with its country code, for example +91…"
                  : "Include the country code."}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="place-call-reason">Reason for the call (optional)</Label>
              <Input
                id="place-call-reason"
                maxLength={OBJECTIVE_MAX}
                placeholder="For example: remind them about their check-up"
                value={objective}
                disabled={placing}
                onChange={(e) => setObjective(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Your assistant uses this to explain why it is calling.
              </p>
            </div>

            {lastError ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm"
              >
                Call not placed: {lastError}
              </p>
            ) : null}

            {blockers.length > 0 ? (
              <ul
                role="alert"
                className="space-y-1 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm"
              >
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                {status.ratePerMinute > 0
                  ? `${formatMoney(status.ratePerMinute, status.currency)} per started minute, charged to your wallet when the call ends. Unanswered calls are free.`
                  : "Outbound calls are not charged on your plan."}{" "}
                {status.maxCallMinutes !== null
                  ? `A call ends after ${status.maxCallMinutes} minutes at most${
                      status.ratePerMinute > 0
                        ? `, so one call costs no more than ${formatMoney(status.ratePerMinute * status.maxCallMinutes, status.currency)}`
                        : ""
                    }. `
                  : ""}
                Up to {status.limits.inFlight} calls at once and {status.limits.perHour} an hour.
                Calls are placed between 9 AM and 9 PM India time, to people who already know your
                business. Wallet balance: {formatMoney(status.walletBalance, status.currency)}.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={placing}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              {placing ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Place call
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
