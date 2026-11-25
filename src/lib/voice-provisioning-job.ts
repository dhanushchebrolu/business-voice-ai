/**
 * Pure rules for the automated Voice AI provisioning job (no I/O, no
 * @/-aliased imports, so the server, the dashboards and the tests share them):
 * the step list, per-step state, outcome classification (retry vs permanent,
 * failure code, customer-safe message), backoff, secret scrubbing and the
 * customer-facing progress view.
 */

/** The steps a customer sees, in order. `complete` is reached only when the number is active. */
export const JOB_STEPS = [
  { key: "validating", label: "Validating your account and business details" },
  { key: "preparing", label: "Preparing your voice assistant" },
  { key: "creating_agent", label: "Creating your voice agent" },
  { key: "configuring_agent", label: "Configuring your voice agent" },
  { key: "verifying_agent", label: "Verifying your voice agent" },
  { key: "authorizing_tools", label: "Securing your agent's connections" },
  { key: "creating_deployment", label: "Creating your phone deployment" },
  { key: "verifying_deployment", label: "Verifying your deployment" },
  { key: "connecting_number", label: "Connecting your phone number" },
  { key: "verifying_number", label: "Verifying your phone number" },
  { key: "activating", label: "Going live" },
  { key: "complete", label: "Complete" },
] as const;

export type JobStepKey = (typeof JOB_STEPS)[number]["key"];
export const JOB_STEP_KEYS: JobStepKey[] = JOB_STEPS.map((s) => s.key);
export const isJobStepKey = (v: unknown): v is JobStepKey =>
  typeof v === "string" && (JOB_STEP_KEYS as string[]).includes(v);

export type StepStatus = "pending" | "running" | "done" | "waiting" | "failed";

export interface StepRecord {
  status: StepStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  code?: string;
}
export type StepStates = Partial<Record<JobStepKey, StepRecord>>;

/** Starts a step: everything before it is done, it is running (attempt counted). */
export function beginStep(states: StepStates, key: JobStepKey, nowIso: string): StepStates {
  const out: StepStates = { ...states };
  const idx = JOB_STEP_KEYS.indexOf(key);
  for (const k of JOB_STEP_KEYS.slice(0, idx)) {
    const s = out[k];
    if (s?.status !== "done")
      out[k] = {
        attempts: s?.attempts ?? 0,
        ...(s?.startedAt ? { startedAt: s.startedAt } : {}),
        status: "done",
        finishedAt: nowIso,
      };
  }
  const prev = out[key];
  out[key] = { attempts: (prev?.attempts ?? 0) + 1, status: "running", startedAt: nowIso };
  // A later step from an earlier attempt is not "done" for this attempt.
  for (const k of JOB_STEP_KEYS.slice(idx + 1)) delete out[k];
  return out;
}

/** Marks the step the attempt ended on. */
export function endStep(
  states: StepStates,
  key: JobStepKey,
  status: Exclude<StepStatus, "pending" | "running">,
  nowIso: string,
  code?: string,
): StepStates {
  const prev = states[key];
  return {
    ...states,
    [key]: {
      attempts: prev?.attempts ?? 1,
      ...(prev?.startedAt ? { startedAt: prev.startedAt } : {}),
      status,
      finishedAt: nowIso,
      ...(code ? { code } : {}),
    },
  };
}

export type FailureCode =
  | "ORGANIZATION_INELIGIBLE"
  | "ONBOARDING_INCOMPLETE"
  | "VOICE_SETTINGS_INCOMPLETE"
  | "NUMBER_NOT_ASSIGNED"
  | "NUMBER_UNUSABLE"
  | "PROVIDER_SETUP_PENDING"
  | "AWAITING_AGENT_CREATION"
  | "TOOL_AUTH_PENDING"
  | "WAITING_FOR_OPERATOR"
  | "PROVIDER_AUTH_EXPIRED"
  | "PROVIDER_PERMISSION_DENIED"
  | "AGENT_CREATE_FAILED"
  | "AGENT_CREATE_AMBIGUOUS"
  | "AGENT_CONFIG_FAILED"
  | "AGENT_VERIFY_FAILED"
  | "AGENT_MAPPING_INVALID"
  | "DEPLOYMENT_CREATE_FAILED"
  | "DEPLOYMENT_VERIFY_FAILED"
  | "NUMBER_MAPPING_FAILED"
  | "ACTIVATION_FAILED"
  | "PROVIDER_ACTION_REQUIRED"
  | "INTERNAL_ERROR"
  | "RETRIES_EXHAUSTED";

/** What an admin should do about a failure code (shown next to the code). */
export const FAILURE_HINTS: Partial<Record<FailureCode, string>> = {
  AWAITING_AGENT_CREATION:
    "Waiting for the operator: process this work order with Claude Code (Provisioning page → Agent builder).",
  TOOL_AUTH_PENDING:
    "The agent and its six tools exist in Sarvam. Select the ClickAI credential on each tool in the Sarvam console, then confirm with confirm_tool_authentication.",
  WAITING_FOR_OPERATOR:
    "The operator reported it cannot continue (usually Sarvam sign-in expired). Sign in to the Sarvam MCP and process the work order again.",
  PROVIDER_AUTH_EXPIRED: "The provider rejected our authorization. Sign in again, then retry.",
  PROVIDER_PERMISSION_DENIED:
    "The provider credential is not allowed to do this. Fix its permissions.",
  PROVIDER_ACTION_REQUIRED:
    "Sarvam refused an action: resolve it in the Sarvam console, then retry.",
  RETRIES_EXHAUSTED:
    "Automatic retries are used up. Check the diagnostics, then use Retry provisioning.",
};

export const MAX_AUTOMATIC_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 15 * 60_000;

/** 30s, 1m, 2m, 4m … capped at 15m. `attempt` is the attempt that just failed (1-based). */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/** What the pipeline reported, as far as classification needs it. */
export interface OutcomeInput {
  state: string;
  /** The step the attempt was on when it stopped. */
  step: JobStepKey;
  /** An explicit signal from the step itself; wins over the state-based default. */
  failure?: { code: FailureCode; retryable: boolean } | undefined;
  attempts: number;
  maxAttempts: number;
}

export type JobOutcome =
  | { kind: "succeeded" }
  | { kind: "waiting"; code: FailureCode | null; customerMessage: string }
  | { kind: "retry"; code: FailureCode; customerMessage: string }
  | { kind: "failed"; code: FailureCode; retryable: boolean; customerMessage: string };

const WAITING: Record<string, { code: FailureCode | null; message: string }> = {
  waiting_for_onboarding: {
    code: "ONBOARDING_INCOMPLETE",
    message: "Finish setting up your business (hours, services and details), then activate again.",
  },
  waiting_for_voice_language: {
    code: "VOICE_SETTINGS_INCOMPLETE",
    message: "Choose your voice and languages in Voice & language, then activate again.",
  },
  waiting_for_number: {
    code: "NUMBER_NOT_ASSIGNED",
    message: "Your phone number has not been assigned yet. Our team will assign it shortly.",
  },
  waiting_for_connection: {
    code: "PROVIDER_SETUP_PENDING",
    message: "Our team is finishing the phone connection for your account.",
  },
  waiting_for_number_confirmation: {
    code: "PROVIDER_SETUP_PENDING",
    message: "Our team is confirming your phone number with our voice provider.",
  },
  waiting_for_integration_credential: {
    code: "PROVIDER_SETUP_PENDING",
    message: "Our team is preparing your voice assistant. We will let you know when it is live.",
  },
  waiting_for_tool_authentication: {
    code: "TOOL_AUTH_PENDING",
    message:
      "Our team is securing your voice agent's connections. We will let you know when it is live.",
  },
  waiting_for_agent: {
    code: "AWAITING_AGENT_CREATION",
    message: "Our team is setting up your voice agent. We will let you know when it is live.",
  },
  // Inbound is live; the outbound agent is an internal follow-up.
  waiting_for_outbound_credential: { code: null, message: "Your number is live." },
  waiting_for_outbound_agent: { code: null, message: "Your number is live." },
};

const FAILED_DEFAULT: Partial<Record<JobStepKey, { code: FailureCode; retryable: boolean }>> = {
  validating: { code: "ORGANIZATION_INELIGIBLE", retryable: false },
  configuring_agent: { code: "AGENT_MAPPING_INVALID", retryable: false },
  creating_deployment: { code: "DEPLOYMENT_CREATE_FAILED", retryable: true },
  activating: { code: "ACTIVATION_FAILED", retryable: false },
};
const VERIFICATION_DEFAULT: Partial<Record<JobStepKey, FailureCode>> = {
  verifying_agent: "AGENT_VERIFY_FAILED",
  verifying_deployment: "DEPLOYMENT_VERIFY_FAILED",
  connecting_number: "NUMBER_MAPPING_FAILED",
  verifying_number: "NUMBER_MAPPING_FAILED",
  activating: "ACTIVATION_FAILED",
};

export const CUSTOMER_PROBLEM =
  "We could not finish activating your number yet. Our team has been notified and will follow up.";
export const CUSTOMER_RETRYING = "We hit a temporary problem and are trying again automatically.";

/** Maps a pipeline result to what the job does next. Never shows provider detail to customers. */
export function classifyOutcome(i: OutcomeInput): JobOutcome {
  if (i.state === "active") return { kind: "succeeded" };
  const waiting = WAITING[i.state];
  // A waiting step may carry its own code (e.g. the provider credential expired).
  if (waiting)
    return {
      kind: "waiting",
      code: i.failure?.code ?? waiting.code,
      customerMessage: waiting.message,
    };

  let failure: { code: FailureCode; retryable: boolean };
  if (i.failure) failure = i.failure;
  else if (i.state === "verification_failed")
    failure = { code: VERIFICATION_DEFAULT[i.step] ?? "DEPLOYMENT_VERIFY_FAILED", retryable: true };
  else if (i.state === "manual_action_required")
    failure = { code: "PROVIDER_ACTION_REQUIRED", retryable: false };
  else failure = FAILED_DEFAULT[i.step] ?? { code: "INTERNAL_ERROR", retryable: false };

  if (!failure.retryable)
    return {
      kind: "failed",
      code: failure.code,
      retryable: false,
      customerMessage: CUSTOMER_PROBLEM,
    };
  // Bounded: transient failures retry with backoff, then stop as retryable-by-hand.
  if (i.attempts < i.maxAttempts)
    return { kind: "retry", code: failure.code, customerMessage: CUSTOMER_RETRYING };
  return {
    kind: "failed",
    code: "RETRIES_EXHAUSTED",
    retryable: true,
    customerMessage: CUSTOMER_PROBLEM,
  };
}

/** Removes bearer tokens, token-like query values, URLs, and long opaque strings; truncates. */
export function sanitizeDiagnostic(text: string | null | undefined, max = 400): string {
  if (!text) return "";
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /(token|key|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',&]+/gi,
      "$1$2[redacted]",
    )
    .replace(/https?:\/\/[^\s"']+/gi, "[url]")
    .replace(/\+\d{8,15}/g, (m) => maskPhone(m) ?? "")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .slice(0, max);
}

/** Digits masked except the last four: +91 ••••• 8604. */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, "");
  return digits.length <= 4 ? "••••" : `••••${digits.slice(-4)}`;
}

export type JobPhase = "queued" | "running" | "retrying" | "waiting" | "failed" | "completed";

export interface JobRowLike {
  status: string;
  attempts: number;
  current_job_step: string | null;
  step_states: unknown;
  customer_message: string | null;
  retryable: boolean | null;
  next_attempt_at: string | null;
}

export interface CustomerJobView {
  phase: JobPhase;
  currentStep: JobStepKey | null;
  steps: { key: JobStepKey; label: string; status: StepStatus }[];
  message: string;
  /** Customer may press "Try again" (a permanent failure waits for the ClickAI team). */
  canRetry: boolean;
  /** Activation button must be disabled. */
  busy: boolean;
}

/** Real state only: a step is done/running/failed exactly as the job recorded it. */
export function customerJobView(run: JobRowLike | null, numberActive: boolean): CustomerJobView {
  const states = (run?.step_states ?? {}) as StepStates;
  const stepsOf = (all: StepStatus | null): CustomerJobView["steps"] =>
    JOB_STEPS.map((s) => ({
      key: s.key,
      label: s.label,
      status: all ?? states[s.key]?.status ?? "pending",
    }));

  if (numberActive)
    return {
      phase: "completed",
      currentStep: "complete",
      steps: stepsOf("done"),
      message: "Your number is live.",
      canRetry: false,
      busy: false,
    };
  if (!run)
    return {
      phase: "queued",
      currentStep: null,
      steps: stepsOf(null),
      message: "Ready to activate.",
      canRetry: false,
      busy: false,
    };

  const currentStep = isJobStepKey(run.current_job_step) ? run.current_job_step : null;
  const base = { currentStep, steps: stepsOf(null) };
  if (run.status === "running")
    return {
      ...base,
      phase: "running",
      message: "Activating your number…",
      canRetry: false,
      busy: true,
    };
  if (run.status === "pending") {
    const retrying = run.attempts > 0 && run.next_attempt_at !== null;
    return {
      ...base,
      phase: retrying ? "retrying" : "queued",
      message: retrying ? (run.customer_message ?? CUSTOMER_RETRYING) : "Activation is queued.",
      canRetry: false,
      busy: true,
    };
  }
  if (run.status === "waiting")
    return {
      ...base,
      phase: "waiting",
      message: run.customer_message ?? "Our team is preparing your number.",
      // The customer can re-check after finishing their own part (onboarding, voice settings).
      canRetry: true,
      busy: false,
    };
  // Never claim "live" unless ClickAI's own number is verified-active.
  if (run.status === "succeeded")
    return {
      ...base,
      phase: "waiting",
      message: "We are confirming your number is live.",
      canRetry: true,
      busy: false,
    };
  return {
    ...base,
    phase: "failed",
    message: run.customer_message ?? CUSTOMER_PROBLEM,
    canRetry: run.retryable === true,
    busy: false,
  };
}
