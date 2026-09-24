import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createPaymentLink,
  getPaymentLinkStatus,
  mapProviderPaymentLinkStatus,
  RazorpayPaymentsApiError,
} from "./razorpay-payments.server.ts";

const ENV_VARS = ["RAZORPAY_PAYMENTS_API_BASE_URL", "RAZORPAY_ACCOUNT_HEADER_NAME"] as const;
const originalValues: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_VARS) {
    originalValues[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_VARS) {
    if (originalValues[key] === undefined) delete process.env[key];
    else process.env[key] = originalValues[key];
  }
});

function fakeFetch(
  response: { status: number; body: unknown },
  captureRequest?: (input: unknown, init: unknown) => void,
): typeof fetch {
  return (async (input: unknown, init: unknown) => {
    captureRequest?.(input, init);
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const BASE_INPUT = {
  razorpayAccountId: "acc_connected_123",
  amountMinorUnits: 50000,
  currency: "INR",
  description: "Appointment deposit",
  customerName: "Priya Sharma",
  customerPhone: "+919876543210",
  customerEmail: undefined,
  referenceId: "booking-abc-123",
  notes: { booking_id: "booking-abc-123" },
};

describe("mapProviderPaymentLinkStatus", () => {
  test("maps every documented Razorpay Payment Link status to this integration's own PaymentStatus", () => {
    assert.equal(mapProviderPaymentLinkStatus("paid"), "CAPTURED");
    assert.equal(mapProviderPaymentLinkStatus("expired"), "EXPIRED");
    assert.equal(mapProviderPaymentLinkStatus("cancelled"), "CANCELLED");
    assert.equal(mapProviderPaymentLinkStatus("created"), "PENDING");
    assert.equal(mapProviderPaymentLinkStatus("partially_paid"), "PENDING");
  });

  test("an unrecognized status maps to PENDING rather than throwing (never silently treated as failure)", () => {
    assert.equal(mapProviderPaymentLinkStatus("some_future_unknown_status"), "PENDING");
  });
});

describe("createPaymentLink", () => {
  test("sends amount/currency/description/reference_id/notes and returns the link on success", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = fakeFetch(
      {
        status: 200,
        body: { id: "plink_abc", short_url: "https://rzp.io/i/abc", status: "created" },
      },
      (_input, init) => {
        capturedInit = init as RequestInit;
      },
    );
    const result = await createPaymentLink("access-token-xyz", BASE_INPUT, fetchImpl);
    assert.deepEqual(result, {
      providerPaymentLinkId: "plink_abc",
      paymentLinkUrl: "https://rzp.io/i/abc",
      rawStatus: "created",
    });
    const body = JSON.parse(String(capturedInit!.body));
    assert.equal(body.amount, 50000);
    assert.equal(body.currency, "INR");
    assert.equal(body.reference_id, "booking-abc-123");
    assert.equal(body.notes.booking_id, "booking-abc-123");
    assert.equal(body.customer.name, "Priya Sharma");
    assert.equal(body.customer.contact, "+919876543210");
  });

  test("sends the access token as a Bearer header, never Basic auth (this is the OAuth-connected path, not platform billing)", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = fakeFetch(
      {
        status: 200,
        body: { id: "plink_abc", short_url: "https://rzp.io/i/abc", status: "created" },
      },
      (_input, init) => {
        capturedInit = init as RequestInit;
      },
    );
    await createPaymentLink("access-token-xyz", BASE_INPUT, fetchImpl);
    const headers = capturedInit!.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer access-token-xyz");
    assert.doesNotMatch(headers["Authorization"]!, /Basic/);
  });

  test("sends the connected account id under the configurable on-behalf-of header (default X-Razorpay-Account)", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = fakeFetch(
      {
        status: 200,
        body: { id: "plink_abc", short_url: "https://rzp.io/i/abc", status: "created" },
      },
      (_input, init) => {
        capturedInit = init as RequestInit;
      },
    );
    await createPaymentLink("access-token-xyz", BASE_INPUT, fetchImpl);
    const headers = capturedInit!.headers as Record<string, string>;
    assert.equal(headers["X-Razorpay-Account"], "acc_connected_123");
  });

  test("respects RAZORPAY_ACCOUNT_HEADER_NAME override", async () => {
    process.env["RAZORPAY_ACCOUNT_HEADER_NAME"] = "X-Custom-Account-Header";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = fakeFetch(
      {
        status: 200,
        body: { id: "plink_abc", short_url: "https://rzp.io/i/abc", status: "created" },
      },
      (_input, init) => {
        capturedInit = init as RequestInit;
      },
    );
    await createPaymentLink("access-token-xyz", BASE_INPUT, fetchImpl);
    const headers = capturedInit!.headers as Record<string, string>;
    assert.equal(headers["X-Custom-Account-Header"], "acc_connected_123");
    assert.equal(headers["X-Razorpay-Account"], undefined);
  });

  test("respects RAZORPAY_PAYMENTS_API_BASE_URL override, defaulting to the already-verified-in-repo api.razorpay.com/v1", async () => {
    let capturedUrl: string | undefined;
    const fetchImpl = fakeFetch(
      {
        status: 200,
        body: { id: "plink_abc", short_url: "https://rzp.io/i/abc", status: "created" },
      },
      (input) => {
        capturedUrl = String(input);
      },
    );
    await createPaymentLink("access-token-xyz", BASE_INPUT, fetchImpl);
    assert.equal(capturedUrl, "https://api.razorpay.com/v1/payment_links");

    process.env["RAZORPAY_PAYMENTS_API_BASE_URL"] = "https://sandbox.example-razorpay.test/v1";
    await createPaymentLink("access-token-xyz", BASE_INPUT, fetchImpl);
    assert.equal(capturedUrl, "https://sandbox.example-razorpay.test/v1/payment_links");
  });

  test("maps a 401 to a non-retryable unauthorized error", async () => {
    const fetchImpl = fakeFetch({ status: 401, body: { error: { description: "invalid token" } } });
    await assert.rejects(
      () => createPaymentLink("bad-token", BASE_INPUT, fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayPaymentsApiError);
        assert.equal(err.status, 401);
        assert.equal(err.retryable, false);
        return true;
      },
    );
  });

  test("maps a 429 to a retryable rate-limit error", async () => {
    const fetchImpl = fakeFetch({ status: 429, body: {} });
    await assert.rejects(
      () => createPaymentLink("access-token-xyz", BASE_INPUT, fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayPaymentsApiError);
        assert.equal(err.status, 429);
        assert.equal(err.retryable, true);
        return true;
      },
    );
  });

  test("maps a 5xx to a retryable temporarily-unavailable error", async () => {
    const fetchImpl = fakeFetch({ status: 503, body: {} });
    await assert.rejects(
      () => createPaymentLink("access-token-xyz", BASE_INPUT, fetchImpl),
      (err: unknown) => {
        assert.ok(err instanceof RazorpayPaymentsApiError);
        assert.equal(err.retryable, true);
        return true;
      },
    );
  });

  test("throws (never fabricates a link) when the response is missing required fields", async () => {
    const fetchImpl = fakeFetch({ status: 200, body: { status: "created" } });
    await assert.rejects(
      () => createPaymentLink("access-token-xyz", BASE_INPUT, fetchImpl),
      RazorpayPaymentsApiError,
    );
  });

  test("a network failure never crashes the caller with a raw/unhandled error", async () => {
    const throwingFetch: typeof fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => createPaymentLink("access-token-xyz", BASE_INPUT, throwingFetch),
      RazorpayPaymentsApiError,
    );
  });

  test("never includes the access token in a thrown error message", async () => {
    const fetchImpl = fakeFetch({ status: 400, body: { error: { description: "bad request" } } });
    try {
      await createPaymentLink("super-secret-access-token-should-not-leak", BASE_INPUT, fetchImpl);
      assert.fail("expected createPaymentLink to throw");
    } catch (err) {
      assert.doesNotMatch((err as Error).message, /super-secret-access-token-should-not-leak/);
    }
  });
});

describe("getPaymentLinkStatus", () => {
  test("returns the mapped status and amount paid on success", async () => {
    const fetchImpl = fakeFetch({
      status: 200,
      body: { id: "plink_abc", status: "paid", amount_paid: 50000 },
    });
    const result = await getPaymentLinkStatus(
      "access-token-xyz",
      "acc_connected_123",
      "plink_abc",
      fetchImpl,
    );
    assert.deepEqual(result, {
      status: "CAPTURED",
      rawStatus: "paid",
      amountPaidMinorUnits: 50000,
    });
  });

  test("is a GET request against /payment_links/{id}, never mutating provider state", async () => {
    let capturedMethod: string | undefined;
    let capturedUrl: string | undefined;
    const fetchImpl = fakeFetch(
      { status: 200, body: { id: "plink_abc", status: "created" } },
      (input, init) => {
        capturedUrl = String(input);
        capturedMethod = (init as RequestInit).method;
      },
    );
    await getPaymentLinkStatus("access-token-xyz", "acc_connected_123", "plink_abc", fetchImpl);
    assert.equal(capturedMethod, "GET");
    assert.equal(capturedUrl, "https://api.razorpay.com/v1/payment_links/plink_abc");
  });

  test("throws when the response is missing a status field", async () => {
    const fetchImpl = fakeFetch({ status: 200, body: { id: "plink_abc" } });
    await assert.rejects(
      () => getPaymentLinkStatus("access-token-xyz", "acc_connected_123", "plink_abc", fetchImpl),
      RazorpayPaymentsApiError,
    );
  });
});
