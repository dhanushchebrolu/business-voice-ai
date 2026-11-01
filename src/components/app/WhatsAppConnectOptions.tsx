import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { StatusPill } from "@/components/app/primitives";
import { supabase } from "@/integrations/supabase/client";
import {
  BYON_ELIGIBILITY_NOTES,
  byonRequestMessages,
  type ByonRequestOutcome,
} from "@/lib/whatsapp/byon-verification-messages";
import {
  startWhatsAppByonVerification,
  connectWhatsAppByon,
  connectAssignedWhatsAppNumber,
  requestWhatsAppNumber,
  completeWhatsAppEmbeddedSignup,
} from "@/lib/whatsapp-onboarding.functions";
import {
  startWhatsAppEmbeddedSignup,
  type EmbeddedSignupWindow,
} from "@/lib/whatsapp/embedded-signup-client";

/**
 * The three ways to connect a WhatsApp number through Vobiz (ClickAI's
 * WhatsApp BSP): the customer's own number (BYON), a number ClickAI bought
 * and assigned to the workspace, or Embedded Signup. Every step runs server-side (whatsapp-onboarding.functions
 * → whatsapp-vobiz-onboarding.server.ts) as an owner/admin of the selected
 * business's organization. The browser never holds a Vobiz credential; the
 * Meta token a BYON customer pastes is sent once to the server, which hands
 * it to Vobiz and never stores it.
 */

/** Appends Meta's JS SDK once (Embedded Signup only). */
function loadFacebookSdkScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Meta's sign-in window failed to load."));
    document.body.appendChild(script);
  });
}

/**
 * Embedded Signup's browser config: the Meta app and Embedded Signup
 * configuration that Vobiz exchanges the resulting code for (supplied by
 * Vobiz). Public by design — none of it is a secret.
 */
function embeddedSignupConfig() {
  const appId = import.meta.env["VITE_VOBIZ_WHATSAPP_ES_APP_ID"] as string | undefined;
  const configId = import.meta.env["VITE_VOBIZ_WHATSAPP_ES_CONFIG_ID"] as string | undefined;
  const graphApiVersion = import.meta.env["VITE_VOBIZ_WHATSAPP_ES_GRAPH_VERSION"] as
    string | undefined;
  return appId && configId && graphApiVersion ? { appId, configId, graphApiVersion } : null;
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-destructive/25 bg-destructive/12 px-3 py-2 text-xs text-destructive">
      {message}
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function WhatsAppConnectOptions({
  orgId,
  businessId,
  disabled,
  onConnected,
}: {
  orgId: string;
  /** The business the number is for (required when the workspace has more than one). */
  businessId: string | null;
  disabled: boolean;
  onConnected: () => Promise<void> | void;
}) {
  return (
    <Tabs defaultValue="byon" className="w-full">
      <TabsList className="mb-4 flex h-auto flex-wrap">
        <TabsTrigger value="byon">Bring your own number</TabsTrigger>
        <TabsTrigger value="clickai">Number from ClickAI</TabsTrigger>
        <TabsTrigger value="embedded">Embedded Signup</TabsTrigger>
      </TabsList>
      <TabsContent value="byon">
        <ByonOption businessId={businessId} disabled={disabled} onConnected={onConnected} />
      </TabsContent>
      <TabsContent value="clickai">
        <ClickAiNumberOption
          orgId={orgId}
          businessId={businessId}
          disabled={disabled}
          onConnected={onConnected}
        />
      </TabsContent>
      <TabsContent value="embedded">
        <EmbeddedSignupOption
          businessId={businessId}
          disabled={disabled}
          onConnected={onConnected}
        />
      </TabsContent>
    </Tabs>
  );
}

// 1. Bring your own number ---------------------------------------------------

function ByonOption({
  businessId,
  disabled,
  onConnected,
}: {
  businessId: string | null;
  disabled: boolean;
  onConnected: () => Promise<void> | void;
}) {
  const sendCode = useServerFn(startWhatsAppByonVerification);
  const connect = useServerFn(connectWhatsAppByon);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [method, setMethod] = useState<"sms" | "voice">("sms");
  // The number a verification was requested for, and what Vobiz answered.
  const [requested, setRequested] = useState<ByonRequestOutcome | null>(null);
  const codeSentTo = requested?.phoneNumber ?? null;
  const [otpCode, setOtpCode] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState<"code" | "connect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSendCode = async () => {
    setError(null);
    setBusy("code");
    try {
      const r = await sendCode({ data: { businessId, phoneNumber, method } });
      const outcome: ByonRequestOutcome = {
        phoneNumber: r.phoneNumber,
        state: r.state,
        expiresAt: r.expiresAt,
      };
      setRequested(outcome);
      // At most "Vobiz accepted the request": delivery is never confirmed and
      // the number isn't verified or connected yet.
      const messages = byonRequestMessages(outcome);
      if (messages.tone === "success") toast.success(messages.toast);
      else toast.warning(messages.toast);
    } catch (e) {
      setError(errorText(e, "Couldn't send the verification code."));
    } finally {
      setBusy(null);
    }
  };

  const onConnect = async () => {
    if (!codeSentTo) return;
    setError(null);
    setBusy("connect");
    try {
      const r = await connect({
        data: {
          businessId,
          phoneNumber: codeSentTo,
          otpCode,
          wabaId,
          phoneNumberId,
          accessToken,
          displayName: displayName || null,
        },
      });
      setAccessToken("");
      toast.success(
        r.alreadyConnected ? "This number is already connected." : "WhatsApp connected.",
      );
      setRequested(null);
      setOtpCode("");
      await onConnected();
    } catch (e) {
      setError(errorText(e, "Couldn't connect the number."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-lg space-y-4">
      {BYON_ELIGIBILITY_NOTES.map((note) => (
        <p key={note} className="text-xs text-muted-foreground">
          {note}
        </p>
      ))}
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field id="byon-phone" label="Phone number (international format)">
          <Input
            id="byon-phone"
            inputMode="tel"
            placeholder="+919876543210"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            disabled={Boolean(codeSentTo) || disabled}
          />
        </Field>
        <Field id="byon-method" label="Send code by">
          <div className="flex gap-2" id="byon-method">
            {(["sms", "voice"] as const).map((m) => (
              <Button
                key={m}
                type="button"
                size="sm"
                variant={method === m ? "default" : "outline"}
                onClick={() => setMethod(m)}
                disabled={Boolean(codeSentTo) || disabled}
              >
                {m === "sms" ? "SMS" : "Voice call"}
              </Button>
            ))}
          </div>
        </Field>
      </div>
      {!codeSentTo ? (
        <Button
          size="sm"
          onClick={onSendCode}
          disabled={disabled || busy !== null || !phoneNumber.trim()}
        >
          {busy === "code" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          Request verification code
        </Button>
      ) : (
        <div className="space-y-3 rounded-lg border border-border p-3">
          {requested ? (
            <p className="text-xs text-muted-foreground">{byonRequestMessages(requested).panel}</p>
          ) : null}
          <Field id="byon-otp" label={`Verification code for ${codeSentTo}`}>
            <Input
              id="byon-otp"
              inputMode="numeric"
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
            />
          </Field>
          <Field
            id="byon-waba"
            label="WhatsApp Business Account ID"
            hint="Meta Business Manager → WhatsApp Accounts."
          >
            <Input
              id="byon-waba"
              inputMode="numeric"
              value={wabaId}
              onChange={(e) => setWabaId(e.target.value)}
            />
          </Field>
          <Field
            id="byon-pnid"
            label="Phone number ID"
            hint="WhatsApp Manager → Phone numbers (the numeric ID, not the number)."
          >
            <Input
              id="byon-pnid"
              inputMode="numeric"
              value={phoneNumberId}
              onChange={(e) => setPhoneNumberId(e.target.value)}
            />
          </Field>
          <Field
            id="byon-token"
            label="Meta system-user access token"
            hint="Starts with EAA. Sent once to Vobiz to connect the number; ClickAI doesn't store it."
          >
            <PasswordInput
              id="byon-token"
              autoComplete="off"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
            />
          </Field>
          <Field id="byon-name" label="Display name (optional)">
            <Input
              id="byon-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={onConnect}
              disabled={
                disabled || busy !== null || !otpCode || !wabaId || !phoneNumberId || !accessToken
              }
            >
              {busy === "connect" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              Connect number
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                setRequested(null);
                setOtpCode("");
                setError(null);
              }}
            >
              Use a different number
            </Button>
          </div>
        </div>
      )}
      <ErrorLine message={error} />
    </div>
  );
}

// 2. A number from ClickAI ------------------------------------------------------
//
// ClickAI buys WhatsApp numbers (platform admins only) and assigns them to a
// workspace; this tab lists the ones assigned here and connects them to the
// customer's WhatsApp Business Account. Customers can't buy numbers.

function numberTone(status: string, connected: boolean): "live" | "ready" | "idle" | "error" {
  if (connected) return "live";
  if (status === "active") return "ready";
  if (status === "suspended") return "error";
  return "idle";
}

function ClickAiNumberOption({
  orgId,
  businessId,
  disabled,
  onConnected,
}: {
  orgId: string;
  businessId: string | null;
  disabled: boolean;
  onConnected: () => Promise<void> | void;
}) {
  const connect = useServerFn(connectAssignedWhatsAppNumber);
  const request = useServerFn(requestWhatsAppNumber);
  const queryClient = useQueryClient();
  // RLS-scoped reads: members only ever see their own organization's rows.
  const { data, isLoading } = useQuery({
    queryKey: ["whatsapp-assigned-numbers", orgId],
    queryFn: async () => {
      const [numbers, connections] = await Promise.all([
        supabase
          .from("phone_numbers")
          .select("id, e164, status")
          .eq("organization_id", orgId)
          .eq("whatsapp_capable", true)
          .not("status", "in", "(released,failed)")
          .order("created_at"),
        supabase
          .from("whatsapp_connections")
          .select("id, inventory_number_id")
          .eq("organization_id", orgId)
          .neq("status", "disconnected")
          .not("inventory_number_id", "is", null),
      ]);
      if (numbers.error) throw numbers.error;
      if (connections.error) throw connections.error;
      const connected = new Set((connections.data ?? []).map((c) => c.inventory_number_id));
      return (numbers.data ?? []).map((n) => ({ ...n, connected: connected.has(n.id) }));
    },
  });
  const [wabaIds, setWabaIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["whatsapp-assigned-numbers", orgId] });

  const onConnect = async (numberId: string) => {
    setError(null);
    setBusy(`connect:${numberId}`);
    try {
      const r = await connect({
        data: { businessId, numberId, wabaId: wabaIds[numberId] ?? "" },
      });
      toast.success(
        r.alreadyConnected ? "This number is already connected." : "WhatsApp connected.",
      );
      await refresh();
      await onConnected();
    } catch (e) {
      setError(errorText(e, "Couldn't connect the number."));
    } finally {
      setBusy(null);
    }
  };

  const onRequest = async () => {
    setError(null);
    setBusy("request");
    try {
      const r = await request({ data: { businessId } });
      toast.success(
        r.alreadyHasNumber
          ? "ClickAI has already assigned you a number."
          : r.alreadyRequested
            ? "Your request is already with our team."
            : "Request sent — our team will assign you a number.",
      );
      await refresh();
    } catch (e) {
      setError(errorText(e, "Couldn't send the request."));
    } finally {
      setBusy(null);
    }
  };

  const numbers = data ?? [];
  return (
    <div className="max-w-lg space-y-4">
      <p className="text-xs text-muted-foreground">
        Use a WhatsApp-ready number provided by ClickAI. Our team buys and assigns it to your
        workspace; once it shows as active, connect it to your WhatsApp Business Account.
      </p>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading your numbers…</p>
      ) : numbers.length === 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            No ClickAI number is assigned to this workspace yet.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || busy !== null}
            onClick={onRequest}
          >
            {busy === "request" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            Ask ClickAI for a number
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {numbers.map((n) => (
            <div key={n.id} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm">{n.e164}</span>
                <StatusPill tone={numberTone(n.status, n.connected)}>
                  {n.connected
                    ? "connected"
                    : n.status === "active"
                      ? "ready to connect"
                      : n.status}
                </StatusPill>
              </div>
              {!n.connected && n.status !== "active" ? (
                <p className="text-xs text-muted-foreground">
                  ClickAI is still setting this number up.
                </p>
              ) : null}
              {!n.connected && n.status === "active" ? (
                <div className="flex items-end gap-2">
                  <Field id={`waba-${n.id}`} label="WhatsApp Business Account ID">
                    <Input
                      id={`waba-${n.id}`}
                      inputMode="numeric"
                      value={wabaIds[n.id] ?? ""}
                      onChange={(e) => setWabaIds((w) => ({ ...w, [n.id]: e.target.value }))}
                    />
                  </Field>
                  <Button
                    size="sm"
                    disabled={disabled || busy !== null || !(wabaIds[n.id] ?? "").trim()}
                    onClick={() => onConnect(n.id)}
                  >
                    {busy === `connect:${n.id}` ? (
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    ) : null}
                    Connect
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <ErrorLine message={error} />
    </div>
  );
}

// 3. Embedded Signup through Vobiz ---------------------------------------------

function EmbeddedSignupOption({
  businessId,
  disabled,
  onConnected,
}: {
  businessId: string | null;
  disabled: boolean;
  onConnected: () => Promise<void> | void;
}) {
  const complete = useServerFn(completeWhatsAppEmbeddedSignup);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const config = embeddedSignupConfig();

  const onStart = async () => {
    if (!config) return;
    setError(null);
    setBusy(true);
    try {
      const outcome = await startWhatsAppEmbeddedSignup(config, {
        win: window as unknown as EmbeddedSignupWindow,
        loadScript: loadFacebookSdkScript,
      });
      if (!outcome.ok) {
        // Closing Meta's window is a choice, not an error.
        if (outcome.reason !== "cancelled") setError(outcome.message);
        return;
      }
      const r = await complete({ data: { ...outcome.result, businessId } });
      toast.success(
        r.alreadyConnected ? "This number is already connected." : "WhatsApp connected.",
      );
      await onConnected();
    } catch (e) {
      setError(errorText(e, "Couldn't connect WhatsApp."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-lg space-y-4">
      <p className="text-xs text-muted-foreground">
        Sign in with your Meta Business account in Meta's own window and choose (or create) the
        WhatsApp Business Account and number. Vobiz completes the connection; you never paste a
        token here.
      </p>
      {config ? (
        <Button size="sm" onClick={onStart} disabled={disabled || busy}>
          {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          Continue with Meta
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          Embedded Signup isn't set up on this deployment yet. Use “Bring your own number” or “Buy a
          number” instead.
        </p>
      )}
      <ErrorLine message={error} />
    </div>
  );
}
