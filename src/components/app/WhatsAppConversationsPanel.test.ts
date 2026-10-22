import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The panel can't be rendered by this test runner, so the retry rule is
 * checked in the source: pressing Send again on the same draft must reuse
 * the draft's request id (the server's idempotency key), so a message whose
 * delivery is unknown can't be sent twice.
 */
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "WhatsAppConversationsPanel.tsx"),
  "utf8",
);

function onSend(): string {
  const start = src.indexOf("const onSend = async");
  assert.ok(start > -1);
  return src.slice(start, src.indexOf("\n  };\n", start));
}

describe("staff reply retries", () => {
  test("the request id is kept per draft, not generated on each Send", () => {
    assert.doesNotMatch(onSend(), /clientRequestId: crypto\.randomUUID\(\)/);
    assert.match(onSend(), /clientRequestId: requestId/);
  });

  test("a new request id only when the text or conversation changes, or after a confirmed send", () => {
    const changes = src.match(/setRequestId\(crypto\.randomUUID\(\)\)/g) ?? [];
    assert.equal(changes.length, 3);
    assert.match(src, /if \(c\.id !== selectedId\) setRequestId\(crypto\.randomUUID\(\)\);/);
    assert.match(
      src,
      /onChange=\{\(e\) => \{\s*setDraft\(e\.target\.value\);\s*setRequestId\(crypto\.randomUUID\(\)\);/,
    );
    const ok = onSend().indexOf("if (result.ok)");
    const renew = onSend().indexOf("setRequestId(crypto.randomUUID())");
    assert.ok(ok > -1 && renew > ok);
  });

  test("delivery unknown keeps the draft and its request id, with a warning instead of an error to retry", () => {
    const body = onSend();
    const unknown = body.indexOf("result.deliveryUnknown");
    assert.ok(unknown > -1);
    assert.match(body.slice(unknown, unknown + 300), /toast\.warning\(result\.message/);
  });

  test("a duplicate is not announced as a newly sent reply", () => {
    assert.match(onSend(), /result\.duplicate/);
  });
});
