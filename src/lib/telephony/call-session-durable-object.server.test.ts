import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CallSessionDurableObject } from "./call-session-durable-object.server.ts";

const root = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("CallSessionDurableObject: an inert compatibility stub", () => {
  test("every request, a media upgrade included, is answered 410 Gone", async () => {
    const stub = new CallSessionDurableObject();
    for (const request of [
      new Request("https://call-session/internal/start-runtime", { method: "POST", body: "{}" }),
      new Request("https://call-session/internal/terminate-runtime", { method: "POST" }),
      new Request("https://call-session/anything", { headers: { upgrade: "websocket" } }),
    ])
      assert.equal((await stub.fetch(request)).status, 410);
  });

  test("the class stays exported, bound and migrated: removing it needs a destructive migration", () => {
    const config = JSON.parse(root("wrangler.json")) as {
      durable_objects: { bindings: { name: string; class_name: string }[] };
      migrations: { tag: string; new_sqlite_classes?: string[]; deleted_classes?: string[] }[];
    };
    assert.ok(
      config.durable_objects.bindings.some(
        (b) => b.name === "CALL_SESSION" && b.class_name === "CallSessionDurableObject",
      ),
    );
    assert.deepEqual(
      config.migrations.find((m) => m.tag === "v1-call-session")?.new_sqlite_classes,
      ["CallSessionDurableObject"],
    );
    assert.equal(
      config.migrations.some((m) => m.deleted_classes),
      false,
    );
    assert.match(
      root("exports.cloudflare.ts"),
      /export \{ CallSessionDurableObject \} from "\.\/src\/lib\/telephony\/call-session-durable-object\.server";/,
    );
  });
});
