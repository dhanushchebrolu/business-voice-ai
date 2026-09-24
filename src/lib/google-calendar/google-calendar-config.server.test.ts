import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  validateGoogleCalendarEnv,
  resolveGoogleCalendarConfig,
  GOOGLE_CALENDAR_SCOPES,
} from "./google-calendar-config.server.ts";

const VARS = [
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  "GOOGLE_CALENDAR_REDIRECT_URI",
] as const;
const originalValues: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of VARS) originalValues[key] = process.env[key];
});

afterEach(() => {
  for (const key of VARS) {
    if (originalValues[key] === undefined) delete process.env[key];
    else process.env[key] = originalValues[key];
  }
});

describe("validateGoogleCalendarEnv", () => {
  test("reports all present when all three vars are set", () => {
    process.env["GOOGLE_CALENDAR_CLIENT_ID"] = "id";
    process.env["GOOGLE_CALENDAR_CLIENT_SECRET"] = "secret";
    process.env["GOOGLE_CALENDAR_REDIRECT_URI"] =
      "https://clickai.in/api/public/integrations/google-calendar/callback";
    const result = validateGoogleCalendarEnv();
    assert.equal(result.allPresent, true);
    assert.deepEqual(result.missing, []);
  });

  test("lists exactly which variables are missing", () => {
    delete process.env["GOOGLE_CALENDAR_CLIENT_ID"];
    delete process.env["GOOGLE_CALENDAR_CLIENT_SECRET"];
    process.env["GOOGLE_CALENDAR_REDIRECT_URI"] = "https://clickai.in/callback";
    const result = validateGoogleCalendarEnv();
    assert.equal(result.allPresent, false);
    assert.deepEqual(result.missing, [
      "GOOGLE_CALENDAR_CLIENT_ID",
      "GOOGLE_CALENDAR_CLIENT_SECRET",
    ]);
  });

  test("never includes the actual configured value anywhere in the result", () => {
    process.env["GOOGLE_CALENDAR_CLIENT_SECRET"] = "super-secret-value-xyz";
    const result = validateGoogleCalendarEnv();
    assert.doesNotMatch(JSON.stringify(result), /super-secret-value-xyz/);
  });
});

describe("resolveGoogleCalendarConfig", () => {
  test("returns null (never throws) when any required value is missing", () => {
    delete process.env["GOOGLE_CALENDAR_CLIENT_ID"];
    process.env["GOOGLE_CALENDAR_CLIENT_SECRET"] = "secret";
    process.env["GOOGLE_CALENDAR_REDIRECT_URI"] = "https://clickai.in/callback";
    assert.equal(resolveGoogleCalendarConfig(), null);
  });

  test("returns the resolved config when everything is present", () => {
    process.env["GOOGLE_CALENDAR_CLIENT_ID"] = "id-123";
    process.env["GOOGLE_CALENDAR_CLIENT_SECRET"] = "secret-456";
    process.env["GOOGLE_CALENDAR_REDIRECT_URI"] = "https://clickai.in/callback";
    assert.deepEqual(resolveGoogleCalendarConfig(), {
      clientId: "id-123",
      clientSecret: "secret-456",
      redirectUri: "https://clickai.in/callback",
    });
  });
});

describe("GOOGLE_CALENDAR_SCOPES", () => {
  test("requests only calendar scopes — nothing broader (Gmail, Drive, profile, etc.)", () => {
    for (const scope of GOOGLE_CALENDAR_SCOPES) {
      assert.match(scope, /^https:\/\/www\.googleapis\.com\/auth\/calendar/);
    }
  });

  test("requests exactly the minimum pair needed: list calendars + manage events", () => {
    assert.deepEqual(
      [...GOOGLE_CALENDAR_SCOPES].sort(),
      [
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.readonly",
      ].sort(),
    );
  });
});
