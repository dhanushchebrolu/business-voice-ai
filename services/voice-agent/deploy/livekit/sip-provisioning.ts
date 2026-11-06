/**
 * Idempotent, verified LiveKit SIP provisioning (Phase 2.15). Used by
 * provision-sip.ts (the CLI); separated so it can be tested against
 * livekit-server-sdk's real SipClient with a stubbed transport.
 *
 * Managed objects (found by NAME; more than one object with a managed name
 * is refused as ambiguous):
 *   inbound trunk  "clickai-vobiz-inbound"   numbers + allowed addresses
 *   dispatch rule  "clickai-receptionist"    individual rooms "call-…",
 *                                            explicit dispatch of the agent,
 *                                            restricted to the inbound trunk
 *   outbound trunk "clickai-vobiz-outbound"  ONLY when explicitly requested
 *                                            (desired.outbound); never
 *                                            updated or deleted here
 *
 * Why this exists: livekit-server-sdk 2.19.2's partial updates take
 * ListUpdate messages ({ set | add | remove | clear }); the previous script
 * passed plain arrays, which serialize to an EMPTY update ({}), so LiveKit
 * changed nothing while the script printed "applied". The dispatch rule's
 * agent dispatch (roomConfig) cannot be changed by a partial update at all
 * (SIPDispatchRuleUpdate has no roomConfig field): it is changed by a full
 * replace (updateSipDispatchRule) built from the rule as read.
 *
 * Every apply ends with a read-back; any difference from the requested
 * configuration throws ProvisionError (the CLI exits non-zero). A dry run
 * (apply=false) only lists objects.
 */
import {
  RoomAgentDispatch,
  RoomConfiguration,
  SIPDispatchRule,
  SIPDispatchRuleIndividual,
  type SIPDispatchRuleInfo,
  type SIPInboundTrunkInfo,
  type SipClient,
} from "livekit-server-sdk";

export const INBOUND_TRUNK_NAME = "clickai-vobiz-inbound";
export const OUTBOUND_TRUNK_NAME = "clickai-vobiz-outbound";
export const DISPATCH_RULE_NAME = "clickai-receptionist";
export const ROOM_PREFIX = "call-";

/** The subset of SipClient this module uses (all of it read-only except the create/update calls). */
export type SipApi = Pick<
  SipClient,
  | "listSipInboundTrunk"
  | "createSipInboundTrunk"
  | "updateSipInboundTrunkFields"
  | "listSipDispatchRule"
  | "createSipDispatchRule"
  | "updateSipDispatchRuleFields"
  | "updateSipDispatchRule"
  | "listSipOutboundTrunk"
  | "createSipOutboundTrunk"
>;

export interface DesiredSip {
  inboundNumbers: string[];
  allowedAddresses: string[];
  agentName: string;
  /** Only when outbound is explicitly requested (--with-outbound); null = never create one. */
  outbound: { domain: string; username?: string; password?: string } | null;
}

export type StepAction = "create" | "update" | "replace" | "unchanged" | "skip";
export interface ProvisionPlan {
  inbound: StepAction;
  rule: StepAction;
  outbound: StepAction;
  /** Human-readable differences (never secrets). */
  changes: string[];
}

export class ProvisionError extends Error {
  /** Steps that were applied before the failure (a re-run converges). */
  readonly applied: string[];
  constructor(message: string, applied: string[] = []) {
    super(message);
    this.name = "ProvisionError";
    this.applied = applied;
  }
}

const E164 = /^\+[1-9]\d{6,14}$/;
// IPv4 address or CIDR (Vobiz publishes IPv4 signalling addresses).
const IPV4_CIDR =
  /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/([0-9]|[12]\d|3[0-2]))?$/;

/** Validates the requested configuration before anything is read or written. */
export function validateDesired(d: DesiredSip, appEnv: string): void {
  if (d.inboundNumbers.length === 0)
    // An inbound trunk without numbers is not created or left behind by
    // this tool: it could match calls to any number. Remove the last
    // number by deleting the trunk/rule by hand (RUNBOOK.md).
    throw new ProvisionError("SIP_INBOUND_NUMBERS must list at least one number");
  for (const n of d.inboundNumbers) if (!E164.test(n)) throw new ProvisionError(`not E.164: ${n}`);
  if (new Set(d.inboundNumbers).size !== d.inboundNumbers.length)
    throw new ProvisionError("SIP_INBOUND_NUMBERS contains duplicates");
  for (const a of d.allowedAddresses)
    if (!IPV4_CIDR.test(a)) throw new ProvisionError(`not an IPv4 address or CIDR: ${a}`);
  if (
    appEnv !== "development" &&
    (d.allowedAddresses.length === 0 ||
      d.allowedAddresses.some((a) => a === "0.0.0.0/0" || a.endsWith("/0")))
  )
    throw new ProvisionError(
      "VOBIZ_SIP_SIGNALING_IPS must list Vobiz's signalling IPs outside development",
    );
  if (!/^[a-z0-9-]{3,64}$/.test(d.agentName)) throw new ProvisionError("invalid AGENT_NAME");
  if (d.outbound && !/^[a-z0-9.-]+$/i.test(d.outbound.domain))
    throw new ProvisionError("invalid VOBIZ_OUTBOUND_SIP_DOMAIN");
}

const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();
const sameSet = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** A ListUpdate that REPLACES the list (an empty list is `clear`, since proto3 JSON drops `set: []`). */
type ListUpdateArg = NonNullable<
  Parameters<SipClient["updateSipInboundTrunkFields"]>[1]["numbers"]
>;
export const listSet = (values: readonly string[]) =>
  (values.length ? { set: [...values] } : { clear: true }) as unknown as ListUpdateArg;

function one<T extends { name: string }>(items: T[], name: string, what: string): T | null {
  const found = items.filter((i) => i.name === name);
  if (found.length > 1)
    throw new ProvisionError(
      `ambiguous: ${found.length} ${what} named "${name}"; remove the duplicates in the LiveKit dashboard first`,
    );
  return found[0] ?? null;
}

interface RuleView {
  individualPrefix: string | null;
  trunkIds: string[];
  agents: string[];
}
function viewRule(r: SIPDispatchRuleInfo): RuleView {
  const rule = r.rule?.rule;
  return {
    individualPrefix:
      rule?.case === "dispatchRuleIndividual" ? (rule.value.roomPrefix ?? "") : null,
    trunkIds: [...(r.trunkIds ?? [])],
    agents: (r.roomConfig?.agents ?? []).map((a) => a.agentName),
  };
}

function desiredRoomConfig(agentName: string) {
  return new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName })] });
}
function desiredRule() {
  return new SIPDispatchRule({
    rule: {
      case: "dispatchRuleIndividual",
      value: new SIPDispatchRuleIndividual({ roomPrefix: ROOM_PREFIX }),
    },
  });
}

interface State {
  inbound: SIPInboundTrunkInfo | null;
  rule: SIPDispatchRuleInfo | null;
  outboundCount: number;
  outboundExists: boolean;
}
async function readState(sip: SipApi): Promise<State> {
  const [inbound, rules, outbound] = await Promise.all([
    sip.listSipInboundTrunk(),
    sip.listSipDispatchRule(),
    sip.listSipOutboundTrunk(),
  ]);
  return {
    inbound: one(inbound, INBOUND_TRUNK_NAME, "inbound trunks"),
    rule: one(rules, DISPATCH_RULE_NAME, "dispatch rules"),
    outboundCount: outbound.length,
    outboundExists: !!one(outbound, OUTBOUND_TRUNK_NAME, "outbound trunks"),
  };
}

export function planFor(state: State, d: DesiredSip): ProvisionPlan {
  const changes: string[] = [];
  let inbound: StepAction = "unchanged";
  if (!state.inbound) {
    inbound = "create";
    changes.push(`create inbound trunk ${INBOUND_TRUNK_NAME}`);
  } else {
    if (!sameSet(state.inbound.numbers, d.inboundNumbers)) {
      inbound = "update";
      changes.push(
        `inbound numbers: [${sorted(state.inbound.numbers).join(", ")}] -> [${sorted(d.inboundNumbers).join(", ")}]`,
      );
    }
    if (!sameSet(state.inbound.allowedAddresses, d.allowedAddresses)) {
      inbound = "update";
      changes.push(
        `inbound allowed addresses: ${state.inbound.allowedAddresses?.length ?? 0} -> ${d.allowedAddresses.length} entries`,
      );
    }
  }
  let rule: StepAction = "unchanged";
  if (!state.rule) {
    rule = "create";
    changes.push(`create dispatch rule ${DISPATCH_RULE_NAME}`);
  } else {
    const v = viewRule(state.rule);
    const shapeOk = v.individualPrefix === ROOM_PREFIX;
    const agentsOk = v.agents.length === 1 && v.agents[0] === d.agentName;
    const trunkOk =
      !!state.inbound && v.trunkIds.length === 1 && v.trunkIds[0] === state.inbound.sipTrunkId;
    if (!shapeOk || !agentsOk) {
      rule = "replace";
      if (!shapeOk) changes.push(`dispatch rule: individual "${ROOM_PREFIX}" rooms`);
      if (!agentsOk)
        changes.push(`dispatch rule agents: [${v.agents.join(", ")}] -> [${d.agentName}]`);
      if (!trunkOk) changes.push("dispatch rule trunks -> the inbound trunk only");
    } else if (!trunkOk) {
      rule = "update";
      changes.push("dispatch rule trunks -> the inbound trunk only");
    }
  }
  let outbound: StepAction = "skip";
  if (d.outbound) {
    outbound = state.outboundExists ? "unchanged" : "create";
    if (outbound === "create") changes.push(`create outbound trunk ${OUTBOUND_TRUNK_NAME}`);
  }
  return { inbound, rule, outbound, changes };
}

/** Compares LiveKit's state with the request; returns the differences (empty = match). */
export function verifyState(state: State, d: DesiredSip, outboundBefore: number): string[] {
  const diffs: string[] = [];
  if (!state.inbound) diffs.push(`inbound trunk ${INBOUND_TRUNK_NAME} missing`);
  else {
    if (!sameSet(state.inbound.numbers, d.inboundNumbers))
      diffs.push(
        `inbound numbers are [${sorted(state.inbound.numbers).join(", ")}], expected [${sorted(d.inboundNumbers).join(", ")}]`,
      );
    if (!sameSet(state.inbound.allowedAddresses, d.allowedAddresses))
      diffs.push("inbound allowed addresses differ from VOBIZ_SIP_SIGNALING_IPS");
  }
  if (!state.rule) diffs.push(`dispatch rule ${DISPATCH_RULE_NAME} missing`);
  else {
    const v = viewRule(state.rule);
    if (v.individualPrefix !== ROOM_PREFIX)
      diffs.push(`dispatch rule is not individual "${ROOM_PREFIX}"`);
    if (!(v.agents.length === 1 && v.agents[0] === d.agentName))
      diffs.push(`dispatch rule agents are [${v.agents.join(", ")}], expected [${d.agentName}]`);
    if (!(state.inbound && v.trunkIds.length === 1 && v.trunkIds[0] === state.inbound.sipTrunkId))
      diffs.push("dispatch rule is not restricted to the inbound trunk");
  }
  if (!d.outbound && state.outboundCount !== outboundBefore)
    diffs.push("an outbound trunk was created although outbound was not requested");
  return diffs;
}

/**
 * Plans, and with apply=true applies and verifies, the SIP configuration.
 * Throws ProvisionError on validation errors, ambiguous state, API failures
 * (with the steps already applied) and read-back mismatches.
 */
export async function provisionSip(
  sip: SipApi,
  d: DesiredSip,
  opts: { apply: boolean; appEnv: string },
): Promise<{ plan: ProvisionPlan; applied: string[] }> {
  validateDesired(d, opts.appEnv);
  const before = await readState(sip);
  const plan = planFor(before, d);
  if (!opts.apply) return { plan, applied: [] };

  const applied: string[] = [];
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    try {
      const r = await fn();
      applied.push(name);
      return r;
    } catch (e) {
      throw new ProvisionError(
        `failed at "${name}": ${String((e as Error)?.message ?? e).slice(0, 200)}` +
          (applied.length ? ` (already applied: ${applied.join(", ")}; re-running converges)` : ""),
        applied,
      );
    }
  };

  let trunkId = before.inbound?.sipTrunkId ?? null;
  if (plan.inbound === "create") {
    const created = await step("create inbound trunk", () =>
      sip.createSipInboundTrunk(INBOUND_TRUNK_NAME, d.inboundNumbers, {
        allowedAddresses: d.allowedAddresses,
        krispEnabled: true,
      }),
    );
    trunkId = created.sipTrunkId;
  } else if (plan.inbound === "update" && trunkId) {
    await step("update inbound trunk", () =>
      sip.updateSipInboundTrunkFields(trunkId!, {
        numbers: listSet(d.inboundNumbers),
        allowedAddresses: listSet(d.allowedAddresses),
      }),
    );
  }
  if (!trunkId) throw new ProvisionError("inbound trunk id unknown after apply", applied);

  // The rule plan was made before the trunk existed: re-evaluate the trunk binding now.
  const rulePlan = before.rule
    ? planFor(
        { ...before, inbound: { ...before.inbound!, sipTrunkId: trunkId } as SIPInboundTrunkInfo },
        d,
      ).rule
    : "create";
  if (rulePlan === "create") {
    await step("create dispatch rule", () =>
      sip.createSipDispatchRule(
        { type: "individual", roomPrefix: ROOM_PREFIX },
        {
          name: DISPATCH_RULE_NAME,
          trunkIds: [trunkId!],
          roomConfig: desiredRoomConfig(d.agentName),
        },
      ),
    );
  } else if (rulePlan === "update") {
    await step("update dispatch rule trunks", () =>
      sip.updateSipDispatchRuleFields(before.rule!.sipDispatchRuleId, {
        trunkIds: listSet([trunkId!]),
      }),
    );
  } else if (rulePlan === "replace") {
    // Full replace built from the rule AS READ (keeps every other field).
    const next = before.rule!.clone();
    next.rule = desiredRule();
    next.trunkIds = [trunkId];
    next.roomConfig = desiredRoomConfig(d.agentName);
    await step("replace dispatch rule", () =>
      sip.updateSipDispatchRule(before.rule!.sipDispatchRuleId, next),
    );
  }

  if (plan.outbound === "create" && d.outbound) {
    const o = d.outbound;
    await step("create outbound trunk", () =>
      sip.createSipOutboundTrunk(OUTBOUND_TRUNK_NAME, o.domain, [], {
        transport: 0 as never, // SIP_TRANSPORT_AUTO
        ...(o.username ? { authUsername: o.username } : {}),
        ...(o.password ? { authPassword: o.password } : {}),
      }),
    );
  }

  // Read back and verify against the request.
  let after: State;
  try {
    after = await readState(sip);
  } catch (e) {
    throw new ProvisionError(
      `applied, but the read-back failed: ${String((e as Error)?.message ?? e).slice(0, 200)}; re-run the dry run to verify`,
      applied,
    );
  }
  const diffs = verifyState(after, d, before.outboundCount);
  if (diffs.length)
    throw new ProvisionError(`verification failed after apply: ${diffs.join("; ")}`, applied);
  return { plan, applied };
}
