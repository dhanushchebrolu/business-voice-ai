import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createDeployment,
  updateDeployment,
  listCampaigns,
  getCampaign,
  updateCampaign,
  createInstantOutbound,
  listDeployments,
  countAgentInteractions,
  listAttempts,
  getRecording,
  getDeployment,
  setDeploymentStatus,
  type SarvamApiClientConfig,
} from "./sarvam-api-client.server.ts";
import { TelephonyAdapterError } from "./adapter.ts";

/**
 * Mocked-at-the-boundary tests for the Sarvam Voice Agents management API
 * client. Every test injects fetchImpl — none makes a real network call,
 * and none ever asserts a "successful deployment/campaign/call" without a
 * controlled mock response standing in for the (unreachable, in this
 * environment) live Sarvam API.
 */

const baseConfig: Omit<SarvamApiClientConfig, "fetchImpl"> = {
  apiKey: "sk_test_secret_value",
  orgId: "org_1",
  workspaceId: "ws_1",
};

function mockFetch(
  status: number,
  body: unknown,
  capture?: { url?: string; init?: RequestInit | undefined },
) {
  return (async (url: string | URL, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.init = init;
    }
    return new Response(body === undefined ? "" : JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("request construction", () => {
  test("createDeployment: POSTs to the exact documented path, scoped by orgId/workspaceId", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const config = {
      ...baseConfig,
      fetchImpl: mockFetch(200, { deployment_id: "dep_1" }, capture),
    };
    await createDeployment(config, {
      name: "n",
      appId: "app_1",
      appVersion: 3,
      connectionId: "conn_1",
      phoneNumbers: ["+911111111111"],
    });
    assert.equal(
      capture.url,
      "https://apps.sarvam.ai/api/app-authoring/v1/orgs/org_1/workspaces/ws_1/deployments",
    );
    assert.equal(capture.init?.method, "POST");
  });

  test("createDeployment: sends connection_configs as an array of {connection_id, phone_numbers} — the confirmed ground-truth shape, not flat top-level fields", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const config = {
      ...baseConfig,
      fetchImpl: mockFetch(200, { deployment_id: "dep_1" }, capture),
    };
    await createDeployment(config, {
      name: "Klyro - Client inbound line",
      description: "Inbound line provisioned by Klyro",
      appId: "app_1",
      appVersion: 3,
      connectionId: "conn_1",
      phoneNumbers: ["+911111111111", "+912222222222"],
      inboundConfig: {
        startTime: "10:00",
        endTime: "20:00",
        allowedDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
        timezone: "Asia/Kolkata",
      },
    });
    const body = JSON.parse(capture.init?.body as string);
    assert.deepEqual(body.connection_configs, [
      { connection_id: "conn_1", phone_numbers: ["+911111111111", "+912222222222"] },
    ]);
    assert.equal(body.connection_id, undefined, "must not also send the old flat connection_id");
    assert.equal(body.phone_numbers, undefined, "must not also send the old flat phone_numbers");
    assert.equal(body.name, "Klyro - Client inbound line");
    assert.equal(body.description, "Inbound line provisioned by Klyro");
    assert.equal(body.app_id, "app_1");
    assert.equal(body.app_version, 3);
    assert.deepEqual(body.inbound_config, {
      start_time: "10:00",
      end_time: "20:00",
      allowed_days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      timezone: "Asia/Kolkata",
    });
  });

  test("updateDeployment: PATCHes to .../deployments/{id}, sending only the fields provided", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const config = {
      ...baseConfig,
      fetchImpl: mockFetch(200, { deployment_id: "dep_1" }, capture),
    };
    await updateDeployment(config, "dep_1", { name: "new-name" });
    assert.equal(
      capture.url,
      "https://apps.sarvam.ai/api/app-authoring/v1/orgs/org_1/workspaces/ws_1/deployments/dep_1",
    );
    assert.equal(capture.init?.method, "PATCH");
    const body = JSON.parse(capture.init?.body as string);
    assert.deepEqual(body, { name: "new-name" });
  });

  test("listCampaigns: GETs the exact endpoint this session verified as a read-only test target", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const config = { ...baseConfig, fetchImpl: mockFetch(200, { campaigns: [] }, capture) };
    await listCampaigns(config);
    assert.equal(
      capture.url,
      "https://apps.sarvam.ai/api/scheduling/v1/orgs/org_1/workspaces/ws_1/campaigns",
    );
    assert.equal(capture.init?.method, "GET");
    assert.equal(capture.init?.body, undefined);
  });

  test("getCampaign: GETs .../campaigns/{id}", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const config = { ...baseConfig, fetchImpl: mockFetch(200, { campaign_id: "camp_1" }, capture) };
    await getCampaign(config, "camp_1");
    assert.equal(
      capture.url,
      "https://apps.sarvam.ai/api/scheduling/v1/orgs/org_1/workspaces/ws_1/campaigns/camp_1",
    );
    assert.equal(capture.init?.method, "GET");
  });

  test("updateCampaign: PATCHes .../campaigns/{id} with name/status/webhook_config", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const config = { ...baseConfig, fetchImpl: mockFetch(200, { campaign_id: "camp_1" }, capture) };
    await updateCampaign(config, "camp_1", {
      name: "renamed",
      status: "paused",
      webhookConfig: { metadata: { source: "klyro" } },
    });
    assert.equal(
      capture.url,
      "https://apps.sarvam.ai/api/scheduling/v1/orgs/org_1/workspaces/ws_1/campaigns/camp_1",
    );
    assert.equal(capture.init?.method, "PATCH");
    const body = JSON.parse(capture.init?.body as string);
    assert.equal(body.name, "renamed");
    assert.equal(body.status, "paused");
    assert.deepEqual(body.webhook_config, { metadata: { source: "klyro" } });
  });

  test("createInstantOutbound: POSTs to the documented outbounds path with the nested app_config/user_config/webhook_config shape", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const config = { ...baseConfig, fetchImpl: mockFetch(200, {}, capture) };
    await createInstantOutbound(config, {
      appId: "app_1",
      appVersion: 2,
      connectionId: "conn_1",
      fromE164: "+912222222222",
      toE164: "+919876543210",
      webhookUrl: "https://klyro.example.com/api/public/webhooks/telephony?provider=sarvam",
      metadata: { organizationId: "org_1" },
    });
    assert.equal(
      capture.url,
      "https://apps.sarvam.ai/api/outbounds/v1/orgs/org_1/workspaces/ws_1/outbounds",
    );
    assert.equal(capture.init?.method, "POST");
    const body = JSON.parse(capture.init?.body as string);
    assert.equal(body.app_config.app_id, "app_1");
    assert.equal(body.app_config.app_version, 2);
    assert.equal(body.app_config.app_type, "agent");
    assert.equal(body.app_config.connection_config.connection_id, "conn_1");
    assert.equal(body.app_config.connection_config.agent_phone_number, "+912222222222");
    assert.equal(body.user_config.user_phone_number, "+919876543210");
    assert.equal(
      body.webhook_config.url,
      "https://klyro.example.com/api/public/webhooks/telephony?provider=sarvam",
    );
    assert.equal(body.webhook_config.metadata.organization_id, "org_1");
  });

  test("createInstantOutbound: metadata carries whichever of lead/campaign/campaign-contact/call ids are supplied, omitting the rest", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const config = { ...baseConfig, fetchImpl: mockFetch(200, {}, capture) };
    await createInstantOutbound(config, {
      appId: "app_1",
      appVersion: 2,
      connectionId: "conn_1",
      fromE164: "+912222222222",
      toE164: "+919876543210",
      webhookUrl: "https://klyro.example.com/api/public/webhooks/telephony?provider=sarvam",
      metadata: {
        organizationId: "org_1",
        campaignId: "camp_1",
        campaignContactId: "cc_1",
      },
    });
    const body = JSON.parse(capture.init?.body as string);
    assert.equal(body.webhook_config.metadata.organization_id, "org_1");
    assert.equal(body.webhook_config.metadata.campaign_id, "camp_1");
    assert.equal(body.webhook_config.metadata.campaign_contact_id, "cc_1");
    assert.equal(body.webhook_config.metadata.lead_id, undefined);
    assert.equal(body.webhook_config.metadata.call_id, undefined);
  });

  test("createInstantOutbound: agentVariables and appOverrides are passed through under app_config, omitted when absent", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const config = { ...baseConfig, fetchImpl: mockFetch(200, {}, capture) };
    await createInstantOutbound(config, {
      appId: "app_1",
      appVersion: 2,
      connectionId: "conn_1",
      fromE164: "+912222222222",
      toE164: "+919876543210",
      webhookUrl: "https://klyro.example.com/api/public/webhooks/telephony?provider=sarvam",
      metadata: { organizationId: "org_1" },
      agentVariables: { customer_name: "Asha" },
      appOverrides: { initialBotMessage: "Hi Asha, this is Smile Dental." },
    });
    const body = JSON.parse(capture.init?.body as string);
    assert.deepEqual(body.app_config.agent_variables, { customer_name: "Asha" });
    assert.equal(
      body.app_config.app_overrides.initial_bot_message,
      "Hi Asha, this is Smile Dental.",
    );
    assert.equal(body.app_config.app_overrides.initial_state_name, undefined);
  });
});

describe("authentication / header construction — never exposes the API key", () => {
  test("every request carries exactly the API key under X-API-Key, and Content-Type only when a body is sent", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const config = { ...baseConfig, fetchImpl: mockFetch(200, { campaigns: [] }, capture) };
    await listCampaigns(config);
    const headers = capture.init?.headers as Record<string, string>;
    assert.equal(headers["X-API-Key"], "sk_test_secret_value");
    assert.equal(headers["Content-Type"], undefined);

    const capture2: { url?: string; init?: RequestInit } = {};
    const config2 = { ...baseConfig, fetchImpl: mockFetch(200, { deployment_id: "d" }, capture2) };
    await createDeployment(config2, {
      name: "n",
      appId: "a",
      appVersion: 1,
      connectionId: "c",
      phoneNumbers: ["+911111111111"],
    });
    const headers2 = capture2.init?.headers as Record<string, string>;
    assert.equal(headers2["X-API-Key"], "sk_test_secret_value");
    assert.equal(headers2["Content-Type"], "application/json");
  });

  test("a thrown error from a 4xx/5xx response never includes the API key or request headers in its message", async () => {
    const config = {
      ...baseConfig,
      fetchImpl: mockFetch(401, { message: "bad key" }),
    };
    await assert.rejects(
      () => listCampaigns(config),
      (err: unknown) => {
        assert.ok(err instanceof TelephonyAdapterError);
        assert.equal(err.message.includes("sk_test_secret_value"), false);
        assert.equal(err.message.includes("X-API-Key"), false);
        return true;
      },
    );
  });
});

describe("HTTP status handling — 400/401/403/429/500/503", () => {
  const cases: Array<[number, number]> = [
    [400, 400],
    [401, 401],
    [403, 403],
    [429, 429],
    [500, 503],
    [502, 503],
    [503, 503],
    [504, 503],
  ];
  for (const [httpStatus, expectedStatus] of cases) {
    test(`upstream ${httpStatus} maps to TelephonyAdapterError.status ${expectedStatus}`, async () => {
      const config = { ...baseConfig, fetchImpl: mockFetch(httpStatus, { message: "x" }) };
      await assert.rejects(
        () => listCampaigns(config),
        (err: unknown) => {
          assert.ok(err instanceof TelephonyAdapterError);
          assert.equal(err.status, expectedStatus);
          return true;
        },
      );
    });
  }

  test("a non-JSON error body does not crash — falls back to a truncated raw-text snippet", async () => {
    const fetchImpl = (async () =>
      new Response("<html>Internal Server Error</html>", { status: 500 })) as typeof fetch;
    const config = { ...baseConfig, fetchImpl };
    await assert.rejects(() => listCampaigns(config), TelephonyAdapterError);
  });
});

describe("network failure / timeout — never fakes success", () => {
  test("a rejected fetch (network error) is normalized to a 503 TelephonyAdapterError, not thrown raw", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND apps.sarvam.ai");
    }) as typeof fetch;
    const config = { ...baseConfig, fetchImpl };
    await assert.rejects(
      () => listCampaigns(config),
      (err: unknown) => {
        assert.ok(err instanceof TelephonyAdapterError);
        assert.equal(err.status, 503);
        return true;
      },
    );
  });

  test("an aborted (timed-out) request is normalized to a 503 TelephonyAdapterError", async () => {
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;
    const config = { ...baseConfig, fetchImpl, timeoutMs: 5 };
    await assert.rejects(
      () => listCampaigns(config),
      (err: unknown) => {
        assert.ok(err instanceof TelephonyAdapterError);
        assert.equal(err.status, 503);
        assert.equal(err.outcomeUnknown, true, "a timed-out request may have reached Sarvam");
        return true;
      },
    );
  });

  test("a network failure leaves the outcome unknown", async () => {
    const fetchImpl = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    await assert.rejects(
      () => listCampaigns({ ...baseConfig, fetchImpl }),
      (err: unknown) => err instanceof TelephonyAdapterError && err.outcomeUnknown === true,
    );
  });
});

describe("outcome classification — definite rejection vs unknown", () => {
  const classify = async (status: number) => {
    try {
      await listCampaigns({ ...baseConfig, fetchImpl: mockFetch(status, { message: "x" }) });
    } catch (err) {
      assert.ok(err instanceof TelephonyAdapterError);
      return err.outcomeUnknown;
    }
    throw new Error("expected a rejection");
  };

  for (const status of [400, 401, 403, 404, 422]) {
    test(`${status} is a definite rejection (outcomeUnknown false)`, async () => {
      assert.equal(await classify(status), false);
    });
  }
  for (const status of [408, 409, 429, 500, 502, 503, 504, 418]) {
    test(`${status} leaves the outcome unknown`, async () => {
      assert.equal(await classify(status), true);
    });
  }

  test("errors built without the flag default to a definite outcome", () => {
    assert.equal(new TelephonyAdapterError("x", 503).outcomeUnknown, false);
  });
});

describe("response parsing — never fabricates an id the response didn't actually return", () => {
  test("createDeployment: a 2xx response missing deployment_id is treated as an error, not a fake success", async () => {
    const config = { ...baseConfig, fetchImpl: mockFetch(200, { ok: true }) };
    await assert.rejects(
      () =>
        createDeployment(config, {
          name: "n",
          appId: "a",
          appVersion: 1,
          connectionId: "c",
          phoneNumbers: ["+911111111111"],
        }),
      (err: unknown) => {
        assert.ok(err instanceof TelephonyAdapterError);
        assert.match(err.message, /deployment_id/);
        return true;
      },
    );
  });

  test("createDeployment: a genuine deployment_id in the response is returned as-is", async () => {
    const config = { ...baseConfig, fetchImpl: mockFetch(200, { deployment_id: "dep_999" }) };
    const result = await createDeployment(config, {
      name: "n",
      appId: "a",
      appVersion: 1,
      connectionId: "c",
      phoneNumbers: ["+911111111111"],
    });
    assert.equal(result.deploymentId, "dep_999");
  });

  test("listCampaigns: parses a { campaigns: [...] } envelope", async () => {
    const config = {
      ...baseConfig,
      fetchImpl: mockFetch(200, { campaigns: [{ campaign_id: "c1" }, { campaign_id: "c2" }] }),
    };
    const result = await listCampaigns(config);
    assert.deepEqual(
      result.campaigns.map((c) => c.campaignId),
      ["c1", "c2"],
    );
  });

  test("listCampaigns: also accepts a bare JSON array response", async () => {
    const config = { ...baseConfig, fetchImpl: mockFetch(200, [{ campaign_id: "c1" }]) };
    const result = await listCampaigns(config);
    assert.deepEqual(
      result.campaigns.map((c) => c.campaignId),
      ["c1"],
    );
  });

  test("listCampaigns: a malformed campaign entry missing campaign_id throws rather than silently dropping it", async () => {
    const config = { ...baseConfig, fetchImpl: mockFetch(200, { campaigns: [{ name: "no id" }] }) };
    await assert.rejects(() => listCampaigns(config), TelephonyAdapterError);
  });

  test("createInstantOutbound: interaction_id present in the response is surfaced", async () => {
    const config = { ...baseConfig, fetchImpl: mockFetch(200, { interaction_id: "int_555" }) };
    const result = await createInstantOutbound(config, {
      appId: "a",
      appVersion: 1,
      connectionId: "c",
      fromE164: "+912222222222",
      toE164: "+919876543210",
      webhookUrl: "https://klyro.example.com/api/public/webhooks/telephony?provider=sarvam",
      metadata: { organizationId: "org_1" },
    });
    assert.equal(result.interactionId, "int_555");
  });

  test("createInstantOutbound: interaction_id absent from the response resolves with interactionId undefined — never fabricated", async () => {
    const config = { ...baseConfig, fetchImpl: mockFetch(200, { accepted: true }) };
    const result = await createInstantOutbound(config, {
      appId: "a",
      appVersion: 1,
      connectionId: "c",
      fromE164: "+912222222222",
      toE164: "+919876543210",
      webhookUrl: "https://klyro.example.com/api/public/webhooks/telephony?provider=sarvam",
      metadata: { organizationId: "org_1" },
    });
    assert.equal(result.interactionId, undefined);
    assert.deepEqual(result.raw, { accepted: true });
  });

  test("createInstantOutbound: the documented { attempt_id } response is surfaced as attemptId", async () => {
    const config = { ...baseConfig, fetchImpl: mockFetch(200, { attempt_id: "att_777" }) };
    const result = await createInstantOutbound(config, {
      appId: "a",
      appVersion: 1,
      connectionId: "c",
      fromE164: "+912222222222",
      toE164: "+919876543210",
      webhookUrl: "https://klyro.example.com/api/public/webhooks/telephony?provider=sarvam",
      metadata: { organizationId: "org_1", callId: "call_1" },
    });
    assert.equal(result.attemptId, "att_777");
    assert.equal(result.interactionId, undefined);
  });
});

describe("read-only agent checks", () => {
  test("listDeployments: GETs the documented app-authoring path with search, no body, and keeps only summary fields", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const config = {
      ...baseConfig,
      fetchImpl: mockFetch(
        200,
        {
          items: [
            {
              deployment_id: "dep_1",
              app_id: "Agent-1",
              app_version: 2,
              phone_numbers: ["+917900000001"],
              channel_direction: "inbound_outbound",
              status: "active",
              created_by: "someone@example.com",
            },
          ],
        },
        capture,
      ),
    };
    const out = await listDeployments(config, "Agent-1");
    assert.equal(capture.init?.method, "GET");
    assert.equal(capture.init?.body, undefined);
    assert.equal(
      capture.url,
      "https://apps.sarvam.ai/api/app-authoring/v1/orgs/org_1/workspaces/ws_1/deployments?search=Agent-1&limit=100",
    );
    assert.deepEqual(out, [
      {
        deploymentId: "dep_1",
        name: null,
        appId: "Agent-1",
        appVersion: 2,
        phoneNumbers: ["+917900000001"],
        channelDirection: "inbound_outbound",
        status: "active",
      },
    ]);
  });

  test("countAgentInteractions: GETs the documented analytics path and returns only the total", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const config = {
      ...baseConfig,
      fetchImpl: mockFetch(200, { items: [{ user_contact: "+919999999999" }], total: 7 }, capture),
    };
    const total = await countAgentInteractions(
      config,
      "Agent-1",
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z"),
    );
    assert.equal(total, 7);
    assert.equal(capture.init?.method, "GET");
    assert.match(
      capture.url ?? "",
      /^https:\/\/apps\.sarvam\.ai\/api\/analytics\/v1\/org_1\/ws_1\/Agent-1\/interactions\?start_datetime=2026-08-01T00%3A00%3A00\.000Z&end_datetime=2026-11-01T00%3A00%3A00\.000Z&limit=1$/,
    );
  });

  test("a 404 for an unknown agent is a definite TelephonyAdapterError", async () => {
    const config = { ...baseConfig, fetchImpl: mockFetch(404, { detail: "not found" }) };
    await assert.rejects(
      countAgentInteractions(config, "nope", new Date(0), new Date()),
      (err: unknown) => err instanceof TelephonyAdapterError && err.status === 404,
    );
  });
});

describe("attempts and recordings", () => {
  test("listAttempts: documented path, oldest first, keeps outcome fields and drops caller contact", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const config = {
      ...baseConfig,
      fetchImpl: mockFetch(
        200,
        {
          items: [
            {
              attempt_id: "att-1",
              interaction_id: "20261111/abc",
              connectivity_status: "connected",
              duration_in_seconds: 42.5,
              next_action_status: "UNKNOWN",
              user_contact: "+919999999999",
            },
          ],
          next_page_uri: "",
        },
        capture,
      ),
    };
    const page = await listAttempts(
      config,
      "app-1",
      new Date("2026-11-11T00:00:00Z"),
      new Date("2026-11-11T06:00:00Z"),
    );
    assert.equal(capture.init?.method, "GET");
    assert.match(
      capture.url ?? "",
      /^https:\/\/apps\.sarvam\.ai\/api\/analytics\/v1\/org_1\/ws_1\/app-1\/attempts\?/,
    );
    assert.match(capture.url ?? "", /sort_by=attempted_at&sort_order=asc&limit=1000&offset=0/);
    assert.equal(page.hasMore, false);
    assert.equal(page.attempts[0]!.interactionId, "20261111/abc");
    assert.equal(page.attempts[0]!.durationSeconds, 42.5);
    assert.ok(
      !JSON.stringify(page).includes("9999999999"),
      "caller contact never leaves the client",
    );
  });

  test("getRecording: bytes for a recording, null for 404, refuses oversized audio", async () => {
    const capture: { url?: string } = {};
    const ok = await getRecording(
      {
        ...baseConfig,
        fetchImpl: (async (url: string | URL) => {
          capture.url = String(url);
          return new Response(new Uint8Array([82, 73, 70, 70]), {
            status: 200,
            headers: { "content-type": "audio/wav" },
          });
        }) as typeof fetch,
      },
      "app-1",
      "20261111/abc",
      1024,
    );
    assert.equal(
      capture.url,
      "https://apps.sarvam.ai/api/analytics/v1/org_1/ws_1/app-1/recordings/20261111/abc",
    );
    assert.equal(ok?.contentType, "audio/wav");
    assert.equal(ok?.bytes.byteLength, 4);
    assert.equal(
      await getRecording(
        { ...baseConfig, fetchImpl: mockFetch(404, { detail: "no" }) },
        "a",
        "b/c",
        1024,
      ),
      null,
    );
    await assert.rejects(
      getRecording(
        {
          ...baseConfig,
          fetchImpl: (async () =>
            new Response(new Uint8Array(2048), { status: 200 })) as typeof fetch,
        },
        "a",
        "b/c",
        1024,
      ),
      /too large/,
    );
  });
});

describe("deployment state", () => {
  test("getDeployment reads either documented connection shape and the webhook", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const d = await getDeployment(
      {
        ...baseConfig,
        fetchImpl: mockFetch(
          200,
          {
            deployment_id: "dep_1",
            app_id: "app_1",
            app_version: 2,
            status: "paused",
            channel_direction: "inbound",
            connection_configs: [
              { connection_id: "c1", agent_phone_number: "+911111111111" },
              { connection_id: "c1", phone_numbers: ["+912222222222"] },
            ],
            webhook_config: { url: "https://x" },
          },
          capture,
        ),
      },
      "dep_1",
    );
    assert.equal(capture.init?.method, "GET");
    assert.equal(
      capture.url,
      "https://apps.sarvam.ai/api/app-authoring/v1/orgs/org_1/workspaces/ws_1/deployments/dep_1",
    );
    assert.deepEqual(d.phoneNumbers, ["+911111111111", "+912222222222"]);
    assert.deepEqual([d.status, d.appVersion, d.webhookUrlConfigured], ["paused", 2, true]);
  });

  test("setDeploymentStatus PUTs the documented action to /status", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await setDeploymentStatus(
      {
        ...baseConfig,
        fetchImpl: mockFetch(
          200,
          { deployment_id: "dep_1", app_id: "a", status: "paused" },
          capture,
        ),
      },
      "dep_1",
      "pause",
    );
    assert.equal(capture.init?.method, "PUT");
    assert.equal(
      capture.url,
      "https://apps.sarvam.ai/api/app-authoring/v1/orgs/org_1/workspaces/ws_1/deployments/dep_1/status",
    );
    assert.deepEqual(JSON.parse(capture.init!.body as string), { action: "pause" });
  });
});
