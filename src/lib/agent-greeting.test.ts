import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { automaticGreeting, customGreetingFor, renderGreeting } from "./agent-greeting.ts";

describe("renderGreeting", () => {
  it("uses the automatic greeting when no custom greeting is set", () => {
    assert.equal(
      renderGreeting("", { businessName: "Smile Dental" }),
      "Welcome to Smile Dental. How can I help you today?",
    );
    assert.equal(
      renderGreeting("   ", { businessName: "Smile Dental" }),
      automaticGreeting("Smile Dental"),
    );
  });

  it("keeps a custom greeting as written and fills placeholders", () => {
    assert.equal(
      renderGreeting("Welcome to {business_name}. Would you like to make a reservation?", {
        businessName: "Spice Garden",
      }),
      "Welcome to Spice Garden. Would you like to make a reservation?",
    );
    assert.equal(
      renderGreeting("నమస్కారం, {{agent_name}} here from {business_name}.", {
        businessName: "Glam Studio",
        agentName: "Priya",
      }),
      "నమస్కారం, Priya here from Glam Studio.",
    );
  });

  it("never mixes tenants: each call renders only its own values", () => {
    const a = renderGreeting("Thanks for calling {business_name}.", {
      businessName: "ABC Properties",
    });
    const b = renderGreeting("", { businessName: "Smile Dental" });
    assert.ok(!a.includes("Smile Dental"));
    assert.ok(!b.includes("ABC Properties"));
  });
});

describe("customGreetingFor", () => {
  it("reads the greeting for the language and ignores bad shapes", () => {
    assert.equal(customGreetingFor({ "en-IN": " Hi " }, "en-IN"), "Hi");
    assert.equal(customGreetingFor({ "en-IN": "Hi" }, "te-IN"), "");
    assert.equal(customGreetingFor(null, "en-IN"), "");
    assert.equal(customGreetingFor(["x"], "0"), "");
  });
});
