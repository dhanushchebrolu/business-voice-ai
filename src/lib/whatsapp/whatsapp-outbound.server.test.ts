import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  deliverWhatsAppMessage,
  sendWhatsAppConversationMessage,
  isWithinCustomerServiceWindow,
  WHATSAPP_SEND_MAX_ATTEMPTS,
  OUTBOUND_PER_MINUTE_PER_CONVERSATION,
} from "./whatsapp-outbound.server.ts";
import { createFakeDb } from "./whatsapp-test-db.ts";

const ORIGINAL_ENV = { ...process.env };
const NOW = new Date("2026-10-18T12:00:00.000Z");
/** ClickAI's Vobiz API token (the only credential the sender holds). */
const ACCESS_TOKEN = "vobiz-test-token-never-logged";
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

beforeEach(() => {
  process.env["VOBIZ_AUTH_ID"] = "MA_TEST";
  process.env["VOBIZ_AUTH_TOKEN"] = ACCESS_TOKEN;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
});

type FetchCall = { url: string; init: RequestInit };

/** Meta stand-in: answers each send from `responses` in order (status + body), or throws for "network"/"timeout". */
function fakeMeta(responses: (number | "network" | "timeout")[]) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r === "network") throw new TypeError("fetch failed");
    if (r === "timeout") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    const body =
      r >= 200 && r < 300
        ? {
            id: `vmsg.SENT${calls.length}`,
            status: "pending",
            meta_message_id: `wamid.SENT${calls.length}`,
          }
        : { error: { message: `Meta error ${r}`, code: r === 429 ? 130429 : 1 } };
    return new Response(JSON.stringify(body), { status: r });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => {};

function seed(
  over: {
    lastInboundAt?: string | null;
    connectionStatus?: string;
    consent?: { action: string; scope?: string; minutesAgo: number }[];
    suppressed?: boolean;
  } = {},
) {
  return {
    whatsapp_connections: [
      {
        id: "conn-a",
        organization_id: "org-a",
        business_id: "biz-a",
        phone_number_id: "PN_A",
        status: over.connectionStatus ?? "connected",
        waba_id: "WABA_A",
        provider: "vobiz",
        vobiz_channel_id: "ch-a",
      },
      {
        id: "conn-b",
        organization_id: "org-b",
        phone_number_id: "PN_B",
        status: "connected",
        provider: "vobiz",
        vobiz_channel_id: "ch-other-tenant-token",
      },
    ],
    whatsapp_conversations: [
      {
        id: "conv-a",
        organization_id: "org-a",
        whatsapp_connection_id: "conn-a",
        wa_id: "919876543210",
        last_inbound_at: over.lastInboundAt === undefined ? hoursAgo(1) : over.lastInboundAt,
      },
    ],
    whatsapp_consent_events: (over.consent ?? []).map((c) => ({
      organization_id: "org-a",
      business_id: "biz-a",
      wa_id: "919876543210",
      scope: c.scope ?? "transactional",
      action: c.action,
      source: "staff_attested",
      created_at: new Date(NOW.getTime() - c.minutesAgo * 60_000).toISOString(),
    })),
    whatsapp_suppressions: over.suppressed
      ? [{ organization_id: "org-a", business_id: "biz-a", wa_id: "919876543210", reason: "staff" }]
      : [],
    whatsapp_templates: [
      registryTemplate("appointment_reminder", "conn-a", "org-a"),
      // The same name on another tenant's number proves nothing for conn-a.
      registryTemplate("other_tenant_template", "conn-b", "org-b"),
      registryTemplate("paused_template", "conn-a", "org-a", { status: "PAUSED" }),
      registryTemplate("promo_template", "conn-a", "org-a", { category: "MARKETING" }),
    ],
  };
}

function registryTemplate(
  name: string,
  connectionId: string,
  organizationId: string,
  over: Record<string, unknown> = {},
) {
  return {
    organization_id: organizationId,
    whatsapp_connection_id: connectionId,
    name,
    language: "en",
    category: "UTILITY",
    status: "APPROVED",
    body_text: "Hi {{1}}",
    body_param_count: 1,
    ...over,
  };
}

const send = (
  db: ReturnType<typeof createFakeDb>,
  over: Record<string, unknown> = {},
  meta = fakeMeta([200]),
) =>
  sendWhatsAppConversationMessage(
    db.client,
    {
      organizationId: "org-a",
      conversationId: "conv-a",
      payload: { kind: "text", body: "Your table is ready." },
      idempotencyKey: "staff:1",
      origin: "staff",
      ...over,
    } as never,
    { fetchImpl: meta.fetchImpl, sleep: noSleep, now: () => NOW },
  );

describe("isWithinCustomerServiceWindow", () => {
  test("open for 24 hours after the customer's latest message, closed after or with none", () => {
    assert.equal(isWithinCustomerServiceWindow(hoursAgo(23.9), NOW), true);
    assert.equal(isWithinCustomerServiceWindow(hoursAgo(24), NOW), false);
    assert.equal(isWithinCustomerServiceWindow(null, NOW), false);
    assert.equal(isWithinCustomerServiceWindow("garbage", NOW), false);
  });
});

describe("sendWhatsAppConversationMessage", () => {
  test("sends a text inside the window through Vobiz and records 'sent' with the wamid and Vobiz's id", async () => {
    const db = createFakeDb(seed());
    const meta = fakeMeta([200]);
    const result = await send(db, {}, meta);
    assert.equal(result.outcome, "sent");
    assert.equal(meta.calls.length, 1);
    assert.equal(meta.calls[0]!.url, "https://api.vobiz.ai/api/v1/messaging/messages");
    const headers = meta.calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["X-Auth-ID"], "MA_TEST");
    assert.equal(headers["X-Auth-Token"], ACCESS_TOKEN);
    const sentBody = JSON.parse(String(meta.calls[0]!.init.body));
    assert.deepEqual(sentBody, {
      channel_id: "ch-a",
      waba_id: "WABA_A",
      to: "+919876543210",
      type: "text",
      text: { body: "Your table is ready." },
    });
    const [row] = db.rows("whatsapp_messages");
    assert.equal(row!["status"], "sent");
    assert.equal(row!["wa_message_id"], "wamid.SENT1");
    assert.equal((row!["metadata"] as Record<string, unknown>)["vobiz_message_id"], "vmsg.SENT1");
    assert.equal(row!["attempts"], 1);
    assert.equal(row!["organization_id"], "org-a");
  });

  test("refuses free-form text outside the 24-hour window, without calling Meta or writing a row", async () => {
    for (const lastInboundAt of [hoursAgo(25), null]) {
      const db = createFakeDb(seed({ lastInboundAt }));
      const meta = fakeMeta([200]);
      assert.deepEqual(await send(db, {}, meta), { outcome: "refused", reason: "window_closed" });
      assert.equal(meta.calls.length, 0);
      assert.equal(db.rows("whatsapp_messages").length, 0);
    }
  });

  test("outside the window an approved template needs the latest transactional consent to be an opt-in, and no suppression", async () => {
    const template = {
      kind: "template",
      name: "appointment_reminder",
      languageCode: "en",
      bodyParams: ["Asha"],
    };
    const cases: [Parameters<typeof seed>[0], string][] = [
      [{}, "no_opt_in"],
      [{ consent: [{ action: "opt_in", scope: "marketing", minutesAgo: 10 }] }, "no_opt_in"],
      [
        {
          consent: [
            { action: "opt_in", minutesAgo: 100 },
            { action: "opt_out", minutesAgo: 10 },
          ],
        },
        "no_opt_in",
      ],
      [{ consent: [{ action: "opt_in", minutesAgo: 10 }], suppressed: true }, "no_opt_in"],
      [
        {
          consent: [
            { action: "opt_out", minutesAgo: 100 },
            { action: "opt_in", minutesAgo: 10 },
          ],
        },
        "sent",
      ],
    ];
    for (const [over, expected] of cases) {
      const db = createFakeDb(seed({ lastInboundAt: hoursAgo(48), ...over }));
      const meta = fakeMeta([200]);
      const result = await send(db, { payload: template }, meta);
      assert.equal(
        result.outcome === "refused" ? result.reason : result.outcome,
        expected,
        JSON.stringify(over),
      );
      if (expected === "sent") {
        const body = JSON.parse(String(meta.calls[0]!.init.body));
        assert.equal(body.type, "template");
        assert.equal(body.template.name, "appointment_reminder");
      } else {
        assert.equal(meta.calls.length, 0);
      }
    }
  });

  test("a staff template is sent only when this number's registry says it's an APPROVED UTILITY template", async () => {
    const optedIn = { consent: [{ action: "opt_in", minutesAgo: 10 }] };
    for (const [name, expected] of [
      ["appointment_reminder", "sent"],
      ["not_synced", "template_unverified"],
      ["other_tenant_template", "template_unverified"],
      ["paused_template", "template_unverified"],
      ["promo_template", "template_unverified"],
    ] as const) {
      for (const lastInboundAt of [hoursAgo(48), hoursAgo(1)]) {
        const db = createFakeDb(seed({ lastInboundAt, ...optedIn }));
        const meta = fakeMeta([200]);
        const result = await send(
          db,
          {
            payload: { kind: "template", name, languageCode: "en", bodyParams: ["Asha"] },
            idempotencyKey: `staff:${name}:${lastInboundAt}`,
          },
          meta,
        );
        assert.equal(
          result.outcome === "refused" ? result.reason : result.outcome,
          expected,
          `${name} @ ${lastInboundAt}`,
        );
        assert.equal(meta.calls.length, expected === "sent" ? 1 : 0);
      }
    }
  });

  test("another organization's conversation is not found (tenant id comes from the caller's server-side state)", async () => {
    const db = createFakeDb(seed());
    const meta = fakeMeta([200]);
    const result = await send(db, { organizationId: "org-b" }, meta);
    assert.deepEqual(result, { outcome: "refused", reason: "not_found" });
    assert.equal(meta.calls.length, 0);
  });

  test("a disconnected number is refused", async () => {
    const db = createFakeDb(seed({ connectionStatus: "disconnected" }));
    assert.deepEqual(await send(db), { outcome: "refused", reason: "not_connected" });
  });

  test("an empty body is refused", async () => {
    const db = createFakeDb(seed());
    assert.deepEqual(await send(db, { payload: { kind: "text", body: "   " } }), {
      outcome: "refused",
      reason: "empty",
    });
  });

  describe("after the customer's own opt-out (STOP) or Meta's", () => {
    const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
    const event = (scope: string, action: string, source: string, minutesAgo: number) => ({
      organization_id: "org-a",
      business_id: "biz-a",
      wa_id: "919876543210",
      scope,
      action,
      source,
      created_at: at(minutesAgo),
    });
    const stopAt = 30;
    // The STOP message is the customer's latest message: it opened the window.
    const afterStop = (lastInboundMinutesAgo = stopAt, extra: Record<string, unknown>[] = []) => {
      const db = createFakeDb(seed({ lastInboundAt: at(lastInboundMinutesAgo) }));
      db.rows("whatsapp_consent_events").push(
        event("transactional", "opt_out", "customer_keyword", stopAt),
        event("marketing", "opt_out", "customer_keyword", stopAt),
        ...extra,
      );
      return db;
    };
    const template = {
      kind: "template",
      name: "appointment_reminder",
      languageCode: "en",
      bodyParams: ["Asha"],
    };

    test("staff free text and templates are refused, even inside the 24-hour window", async () => {
      for (const payload of [{ kind: "text", body: "Special offer just for you!" }, template]) {
        const db = afterStop();
        const meta = fakeMeta([200]);
        assert.deepEqual(await send(db, { payload }, meta), {
          outcome: "refused",
          reason: "opted_out",
        });
        assert.equal(meta.calls.length, 0);
        assert.equal(db.rows("whatsapp_messages").length, 0);
      }
    });

    test("a system-origin conversation message is refused too, and so is every retry", async () => {
      const db = afterStop();
      const meta = fakeMeta([200]);
      for (let i = 0; i < 3; i++) {
        assert.equal(
          (await send(db, { origin: "system", idempotencyKey: `system:${i}` }, meta)).outcome,
          "refused",
        );
      }
      assert.equal(meta.calls.length, 0);
    });

    test("a later message from the customer re-opens the conversation", async () => {
      const db = afterStop(stopAt - 5);
      assert.equal((await send(db)).outcome, "sent");
    });

    test("the customer's own later opt-in (their form) clears it", async () => {
      const db = afterStop(stopAt, [
        event("transactional", "opt_in", "customer_form", stopAt - 10),
        event("marketing", "opt_in", "customer_form", stopAt - 10),
      ]);
      assert.equal((await send(db)).outcome, "sent");
    });

    test("a staff-attested opt-in does not clear it", async () => {
      const db = afterStop(stopAt, [
        event("transactional", "opt_in", "staff_attested", stopAt - 10),
        event("marketing", "opt_in", "staff_attested", stopAt - 10),
      ]);
      assert.equal((await send(db)).outcome, "refused");
    });

    test("Meta's 'stopped marketing' signal blocks staff messages until the customer writes again", async () => {
      const signal = (lastInbound: number) => {
        const db = createFakeDb(seed({ lastInboundAt: at(lastInbound) }));
        db.rows("whatsapp_consent_events").push(event("marketing", "opt_out", "meta_signal", 20));
        return db;
      };
      assert.equal((await send(signal(60))).outcome, "refused");
      assert.equal((await send(signal(10))).outcome, "sent");
    });

    test("a staff-recorded opt-out doesn't block customer-service replies (unchanged)", async () => {
      const db = createFakeDb(seed({ lastInboundAt: at(30) }));
      db.rows("whatsapp_consent_events").push(
        event("transactional", "opt_out", "staff_attested", 20),
      );
      assert.equal((await send(db)).outcome, "sent");
    });
  });

  test("the same idempotency key is sent once (double-submit)", async () => {
    const db = createFakeDb(seed());
    const meta = fakeMeta([200]);
    assert.equal((await send(db, {}, meta)).outcome, "sent");
    assert.deepEqual(await send(db, {}, meta), { outcome: "duplicate" });
    assert.equal(meta.calls.length, 1);
    assert.equal(db.rows("whatsapp_messages").length, 1);
  });

  test("an unknown delivery outcome is reported as ambiguous, and a retry with the same key sends nothing", async () => {
    for (const r of ["timeout", "network"] as const) {
      const db = createFakeDb(seed());
      const meta = fakeMeta([r, 200]);
      const first = await send(db, {}, meta);
      assert.equal(first.outcome, "failed", r);
      assert.equal((first as { ambiguous?: boolean }).ambiguous, true, r);
      assert.equal(db.rows("whatsapp_messages")[0]!["status"], "queued", r);
      // Staff pressing Send again on the same draft reuses its request id.
      assert.deepEqual(await send(db, {}, meta), { outcome: "duplicate" }, r);
      assert.equal(meta.calls.length, 1, r);
      assert.equal(db.rows("whatsapp_messages").length, 1, r);
    }
  });

  test("a definite failure is not reported as ambiguous", async () => {
    const db = createFakeDb(seed());
    const result = await send(db, {}, fakeMeta([400]));
    assert.equal(result.outcome, "failed");
    assert.notEqual((result as { ambiguous?: boolean }).ambiguous, true);
  });

  test("a failed send does not block a retry with the same key", async () => {
    const db = createFakeDb(seed());
    assert.equal((await send(db, {}, fakeMeta([400]))).outcome, "failed");
    assert.equal((await send(db, {}, fakeMeta([200]))).outcome, "sent");
  });

  test("rate limit: at most OUTBOUND_PER_MINUTE_PER_CONVERSATION sends per minute", async () => {
    const db = createFakeDb(seed(), { now: () => NOW });
    const meta = fakeMeta([200]);
    for (let i = 0; i < OUTBOUND_PER_MINUTE_PER_CONVERSATION; i++) {
      assert.equal((await send(db, { idempotencyKey: `k${i}` }, meta)).outcome, "sent");
    }
    assert.deepEqual(await send(db, { idempotencyKey: "one-more" }, meta), {
      outcome: "refused",
      reason: "rate_limited",
    });
    assert.equal(meta.calls.length, OUTBOUND_PER_MINUTE_PER_CONVERSATION);
  });
});

describe("deliverWhatsAppMessage — retries and failures", () => {
  function queued() {
    const s = seed() as Record<string, Record<string, unknown>[]>;
    s["whatsapp_messages"] = [
      {
        id: "row-1",
        organization_id: "org-a",
        whatsapp_connection_id: "conn-a",
        conversation_id: "conv-a",
        direction: "outbound",
        message_type: "text",
        status: "queued",
      },
    ];
    const db = createFakeDb(s);
    const connection = db.rows("whatsapp_connections")[0] as never;
    return { db, connection };
  }
  const deliver = (
    db: ReturnType<typeof createFakeDb>,
    connection: never,
    meta: ReturnType<typeof fakeMeta>,
    sleeps: number[] = [],
  ) =>
    deliverWhatsAppMessage(
      db.client,
      {
        messageRowId: "row-1",
        connection,
        to: "919876543210",
        payload: { kind: "text", body: "hi" },
      },
      { fetchImpl: meta.fetchImpl, sleep: async (ms) => void sleeps.push(ms) },
    );

  test("retries Meta 429 and 5xx with backoff, then succeeds", async () => {
    const { db, connection } = queued();
    const meta = fakeMeta([429, 503, 200]);
    const sleeps: number[] = [];
    const result = await deliver(db, connection, meta, sleeps);
    assert.equal(result.outcome, "sent");
    assert.equal(meta.calls.length, 3);
    assert.deepEqual(sleeps, [400, 800]);
    assert.equal(db.rows("whatsapp_messages")[0]!["attempts"], 3);
  });

  test("stops after WHATSAPP_SEND_MAX_ATTEMPTS and records 'failed' with the reason", async () => {
    const { db, connection } = queued();
    const meta = fakeMeta([500]);
    const result = await deliver(db, connection, meta);
    assert.equal(result.outcome, "failed");
    assert.equal(meta.calls.length, WHATSAPP_SEND_MAX_ATTEMPTS);
    const row = db.rows("whatsapp_messages")[0]!;
    assert.equal(row["status"], "failed");
    assert.equal(row["attempts"], WHATSAPP_SEND_MAX_ATTEMPTS);
    assert.ok(typeof row["error_message"] === "string" && row["error_message"].length > 0);
  });

  test("a rejection (4xx) is never retried", async () => {
    const { db, connection } = queued();
    const meta = fakeMeta([400, 200]);
    assert.equal((await deliver(db, connection, meta)).outcome, "failed");
    assert.equal(meta.calls.length, 1);
  });

  test("an unknown outcome (timeout, dropped connection) is never retried — Meta may already have delivered it", async () => {
    for (const r of ["timeout", "network"] as const) {
      const { db, connection } = queued();
      const meta = fakeMeta([r, 200]);
      assert.equal((await deliver(db, connection, meta)).outcome, "failed");
      assert.equal(meta.calls.length, 1, r);
    }
  });

  test("a 200 without a message id is not retried (Meta accepted it)", async () => {
    const { db, connection } = queued();
    const calls: unknown[] = [];
    const fetchImpl = (async () => {
      calls.push(1);
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await deliverWhatsAppMessage(
      db.client,
      { messageRowId: "row-1", connection, to: "1", payload: { kind: "text", body: "hi" } },
      { fetchImpl, sleep: noSleep },
    );
    assert.equal(result.outcome, "failed");
    assert.equal(calls.length, 1);
  });

  test("fails without calling Vobiz when config is missing or the number isn't on Vobiz", async () => {
    const { db, connection } = queued();
    const meta = fakeMeta([200]);
    delete process.env["VOBIZ_AUTH_TOKEN"];
    assert.equal((await deliver(db, connection, meta)).outcome, "failed");
    process.env["VOBIZ_AUTH_TOKEN"] = ACCESS_TOKEN;
    const legacy = {
      ...(connection as Record<string, unknown>),
      provider: "meta_direct",
      vobiz_channel_id: null,
    };
    const result = await deliver(db, legacy as never, meta);
    assert.equal(result.outcome, "failed");
    assert.match((result as { error: string }).error, /connected again through Vobiz/);
    assert.equal(meta.calls.length, 0);
  });

  test("the Vobiz API token never appears in logs, stored rows or results", async () => {
    const { db, connection } = queued();
    const logged: string[] = [];
    const original = { warn: console.warn, error: console.error, log: console.log };
    console.warn =
      console.error =
      console.log =
        (...args: unknown[]) => void logged.push(JSON.stringify(args));
    try {
      const result = await deliver(db, connection, fakeMeta([500]));
      logged.push(JSON.stringify(result));
    } finally {
      Object.assign(console, original);
    }
    logged.push(JSON.stringify(db.rows("whatsapp_messages")));
    assert.ok(logged.length > 1);
    for (const line of logged) assert.ok(!line.includes(ACCESS_TOKEN), line);
  });
});
