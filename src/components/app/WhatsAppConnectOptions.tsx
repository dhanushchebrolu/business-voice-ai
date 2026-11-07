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
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  startWhatsAppByonVerification,
  connectWhatsAppByon,
  searchWhatsAppNumbers,
  orderWhatsAppNumber,
  listWhatsAppNumberOrders,
  connectPurchasedWhatsAppNumber,
  completeWhatsAppEmbeddedSignup,
} from "@/lib/whatsapp-onboarding.functions";
import {
  startWhatsAppEmbeddedSignup,
  type EmbeddedSignupWindow,
} from "@/lib/whatsapp/embedded-signup-client";

/**
 * The three ways to connect a WhatsApp number through Vobiz (ClickAI's
 * WhatsApp BSP). Every step runs server-side (whatsapp-onboarding.functions
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
        <TabsTrigger value="buy">Buy a number</TabsTrigger>
        <TabsTrigger value="embedded">Embedded Signup</TabsTrigger>
      </TabsList>
      <TabsContent value="byon">
        <ByonOption businessId={businessId} disabled={disabled} onConnected={onConnected} />
      </TabsContent>
      <TabsContent value="buy">
        <BuyOption
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
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
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
      setCodeSentTo(r.phoneNumber);
      toast.success(`Verification code sent to ${r.phoneNumber}.`);
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
      setCodeSentTo(null);
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
      <p className="text-xs text-muted-foreground">
        Connect a number you already own that has a WhatsApp Business Account in Meta Business
        Manager. Vobiz verifies you own it with a one-time code, then connects it. The number can't
        stay on another WhatsApp provider or the WhatsApp app.
      </p>
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
          Send verification code
        </Button>
      ) : (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <Field id="byon-otp" label={`Code sent to ${codeSentTo}`}>
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
                setCodeSentTo(null);
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

// 2. Buy a number through Vobiz ------------------------------------------------

function orderTone(status: string): "live" | "ready" | "idle" | "error" {
  if (status === "connected") return "live";
  if (status === "completed" || status === "pending" || status === "requested") return "ready";
  if (status === "failed" || status === "cancelled" || status === "unknown") return "error";
  return "idle";
}

function BuyOption({
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
  const search = useServerFn(searchWhatsAppNumbers);
  const order = useServerFn(orderWhatsAppNumber);
  const listOrders = useServerFn(listWhatsAppNumberOrders);
  const connect = useServerFn(connectPurchasedWhatsAppNumber);
  const queryClient = useQueryClient();
  const { data: orders } = useQuery({
    queryKey: ["whatsapp-number-orders", orgId],
    queryFn: () => listOrders(),
    retry: false,
  });
  const [country, setCountry] = useState("IN");
  const [numbers, setNumbers] = useState<string[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [wabaIds, setWabaIds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshOrders = () =>
    queryClient.invalidateQueries({ queryKey: ["whatsapp-number-orders", orgId] });

  const onSearch = async () => {
    setError(null);
    setBusy("search");
    try {
      const r = await search({ data: { businessId, country } });
      setNumbers(r.numbers);
    } catch (e) {
      setError(errorText(e, "Couldn't search for numbers."));
    } finally {
      setBusy(null);
    }
  };

  const onBuy = async (phoneNumber: string) => {
    setConfirming(null);
    setError(null);
    setBusy(`buy:${phoneNumber}`);
    try {
      const r = await order({ data: { businessId, phoneNumber, confirm: true } });
      toast.success(
        r.alreadyOrdered
          ? `${r.phoneNumber} is already on order.`
          : `Ordered ${r.phoneNumber} (${r.status}).`,
      );
      await refreshOrders();
    } catch (e) {
      setError(errorText(e, "Couldn't order the number."));
      await refreshOrders();
    } finally {
      setBusy(null);
    }
  };

  const onConnectOrder = async (orderId: string) => {
    setError(null);
    setBusy(`connect:${orderId}`);
    try {
      const r = await connect({ data: { businessId, orderId, wabaId: wabaIds[orderId] ?? "" } });
      toast.success(
        r.alreadyConnected ? "This number is already connected." : "WhatsApp connected.",
      );
      await refreshOrders();
      await onConnected();
    } catch (e) {
      setError(errorText(e, "Couldn't connect the number."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-lg space-y-4">
      <p className="text-xs text-muted-foreground">
        Get a new WhatsApp-ready number from Vobiz. Once Vobiz completes the order, connect it to
        your WhatsApp Business Account.
      </p>
      <div className="flex items-end gap-2">
        <Field id="buy-country" label="Country code">
          <Input
            id="buy-country"
            className="w-20 uppercase"
            maxLength={2}
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase())}
          />
        </Field>
        <Button
          size="sm"
          onClick={onSearch}
          disabled={disabled || busy !== null || country.length !== 2}
        >
          {busy === "search" ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          Search numbers
        </Button>
      </div>

      {numbers ? (
        numbers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No numbers available right now. Try again later.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {numbers.map((n) => (
              <li key={n} className="flex items-center justify-between px-3 py-2">
                <span className="font-mono text-sm">{n}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || busy !== null}
                  onClick={() => setConfirming(n)}
                >
                  {busy === `buy:${n}` ? (
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  ) : null}
                  Buy
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {orders && orders.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Your number orders</p>
          {orders.map((o) => (
            <div key={o.id} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm">{o.phoneNumber}</span>
                <StatusPill tone={orderTone(o.status)}>{o.status}</StatusPill>
              </div>
              {o.failureReason ? <p className="text-xs text-warning">{o.failureReason}</p> : null}
              {o.status === "pending" || o.status === "completed" ? (
                <div className="flex items-end gap-2">
                  <Field id={`waba-${o.id}`} label="WhatsApp Business Account ID">
                    <Input
                      id={`waba-${o.id}`}
                      inputMode="numeric"
                      value={wabaIds[o.id] ?? ""}
                      onChange={(e) => setWabaIds((w) => ({ ...w, [o.id]: e.target.value }))}
                    />
                  </Field>
                  <Button
                    size="sm"
                    disabled={disabled || busy !== null || !(wabaIds[o.id] ?? "").trim()}
                    onClick={() => onConnectOrder(o.id)}
                  >
                    {busy === `connect:${o.id}` ? (
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    ) : null}
                    Connect
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <ErrorLine message={error} />

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => (!open ? setConfirming(null) : null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Buy {confirming}?</AlertDialogTitle>
            <AlertDialogDescription>
              This orders the number from Vobiz and is charged. Ordering the same number again won't
              buy it twice.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirming && onBuy(confirming)}>
              Buy number
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
