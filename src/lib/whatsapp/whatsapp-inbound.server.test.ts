import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  verifyWebhookHandshake,
  processInboundWhatsAppWebhook,
} from "./whatsapp-inbound.server.ts";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

describe("verifyWebhookHandshake", () => {
  test("returns the challenge when mode is subscribe and the token matches", () => {
    process.env["WHATSAPP_WEBHOOK_VERIFY_TOKEN"] = "secret-token";
    try {
      const result = verifyWebhookHandshake({
        mode: "subscribe",
        verifyToken: "secret-token",
        challenge: "12345",
      });
      assert.equal(result, "12345");
    } finally {
      resetEnv();
    }
  });

  test("returns null when the token does not match", () => {
    process.env["WHATSAPP_WEBHOOK_VERIFY_TOKEN"] = "secret-token";
    try {
      const result = verifyWebhookHandshake({
        mode: "subscribe",
        verifyToken: "wrong-token",
        challenge: "12345",
      });
      assert.equal(result, null);
    } finally {
      resetEnv();
    }
  });

  test("returns null when mode is not subscribe", () => {
    process.env["WHATSAPP_WEBHOOK_VERIFY_TOKEN"] = "secret-token";
    try {
      const result = verifyWebhookHandshake({
        mode: "unsubscribe",
        verifyToken: "secret-token",
        challenge: "12345",
      });
      assert.equal(result, null);
    } finally {
      resetEnv();
    }
  });

  test("returns null when the env var is not configured, never accidentally matching an empty token", () => {
    delete process.env["WHATSAPP_WEBHOOK_VERIFY_TOKEN"];
    const result = verifyWebhookHandshake({
      mode: "subscribe",
      verifyToken: "",
      challenge: "12345",
    });
    assert.equal(result, null);
  });
});

function makeFakeSupabase(script: { table: string; op: string; result: unknown }[]) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  let i = 0;
  function next(table: string, op: string, ...args: unknown[]) {
    calls.push({ table, op, args });
    const entry = script[i];
    i++;
    if (!entry) throw new Error(`test bug: no scripted response for call ${i} (${table}.${op})`);
    return entry.result;
  }

  function insertChain(table: string) {
    return {
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(next(table, "insert")).then(resolve);
      },
      select() {
        return {
          single: () => Promise.resolve(next(table, "insert.select.single")),
        };
      },
    };
  }

  function upsertChain(table: string, payload: unknown, opts: unknown) {
    return {
      select() {
        return {
          single: () => Promise.resolve(next(table, "upsert.select.single", payload, opts)),
        };
      },
    };
  }

  function selectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const chain = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return chain;
      },
      neq(col: string, val: unknown) {
        filters[col] = val;
        return chain;
      },
      maybeSingle: () => Promise.resolve(next(table, "select.maybeSingle", filters)),
    };
    return chain;
  }

  function updateChain(table: string, payload: unknown) {
    const filters: Record<string, unknown> = {};
    const chain = {
      eq(col: string, val: unknown) {
        filters[col] = val;
        return chain;
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve(next(table, "update", payload, filters)).then(resolve);
      },
    };
    return chain;
  }

  const client = {
    from(table: string) {
      return {
        select: () => selectChain(table),
        insert: () => insertChain(table),
        upsert: (payload: unknown, opts: unknown) => upsertChain(table, payload, opts),
        update: (payload: unknown) => updateChain(table, payload),
      };
    },
  };
  return { client: client as never, calls };
}

describe("processInboundWhatsAppWebhook", () => {
  test("short-circuits as duplicate on a redelivered event (webhook_events unique violation)", async () => {
    const { client, calls } = makeFakeSupabase([
      { table: "webhook_events", op: "insert", result: { error: { code: "23505" } } },
    ]);
    const result = await processInboundWhatsAppWebhook(client, {
      rawBody: JSON.stringify({ entry: [] }),
      eventId: "hash-1",
    });
    assert.equal(result.outcome, "duplicate");
    assert.equal(calls.length, 1, "must never process the payload after a duplicate dedupe insert");
  });

  test("applies a status update to whatsapp_messages by wa_message_id, never touching payment/booking tables", async () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "1234567890" },
                statuses: [{ id: "wamid.ABC", status: "delivered", recipient_id: "919876543210" }],
              },
            },
          ],
        },
      ],
    };
    const { client, calls } = makeFakeSupabase([
      { table: "webhook_events", op: "insert", result: { error: null } },
      {
        table: "whatsapp_connections",
        op: "select.maybeSingle",
        result: { data: { id: "conn-1", organization_id: "org-1" }, error: null },
      },
      { table: "whatsapp_messages", op: "update", result: { error: null } },
      { table: "webhook_events", op: "update", result: { error: null } },
    ]);
    const result = await processInboundWhatsAppWebhook(client, {
      rawBody: JSON.stringify(payload),
      eventId: "hash-2",
    });
    assert.equal(result.outcome, "processed");
    const updateCall = calls.find((c) => c.table === "whatsapp_messages" && c.op === "update");
    assert.ok(updateCall);
    assert.deepEqual(updateCall!.args[0], { status: "delivered" });
  });

  test("persists an inbound text message and updates the conversation preview", async () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "1234567890" },
                contacts: [{ profile: { name: "Asha" }, wa_id: "919876543210" }],
                messages: [
                  {
                    id: "wamid.XYZ",
                    from: "919876543210",
                    type: "text",
                    timestamp: "1735000000",
                    text: { body: "Hi, is my slot confirmed?" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const { client, calls } = makeFakeSupabase([
      { table: "webhook_events", op: "insert", result: { error: null } },
      {
        table: "whatsapp_connections",
        op: "select.maybeSingle",
        result: { data: { id: "conn-1", organization_id: "org-1" }, error: null },
      },
      {
        table: "whatsapp_conversations",
        op: "upsert.select.single",
        result: { data: { id: "conv-1" }, error: null },
      },
      { table: "whatsapp_messages", op: "insert", result: { error: null } },
      { table: "whatsapp_conversations", op: "update", result: { error: null } },
      { table: "webhook_events", op: "update", result: { error: null } },
    ]);
    const result = await processInboundWhatsAppWebhook(client, {
      rawBody: JSON.stringify(payload),
      eventId: "hash-3",
    });
    assert.equal(result.outcome, "processed");
    assert.ok(calls.some((c) => c.table === "whatsapp_messages" && c.op === "insert"));
    assert.ok(calls.every((c) => c.table !== "payment_requests" && c.table !== "bookings"));
  });

  test("ignores an event for an unknown phone_number_id rather than throwing", async () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "unknown-id" },
                statuses: [{ id: "w1", status: "sent" }],
              },
            },
          ],
        },
      ],
    };
    const { client } = makeFakeSupabase([
      { table: "webhook_events", op: "insert", result: { error: null } },
      {
        table: "whatsapp_connections",
        op: "select.maybeSingle",
        result: { data: null, error: null },
      },
      { table: "webhook_events", op: "update", result: { error: null } },
    ]);
    const result = await processInboundWhatsAppWebhook(client, {
      rawBody: JSON.stringify(payload),
      eventId: "hash-4",
    });
    assert.equal(result.outcome, "ignored");
  });
});
