import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildVobizDeniedXml, buildVobizStreamXml } from "./vobiz-xml.ts";

describe("buildVobizStreamXml", () => {
  test("wraps a <Stream> element in a <Response> root, body = the wss:// URL", () => {
    const xml = buildVobizStreamXml("wss://clickai.test/api/public/media-stream/vobiz");
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?><Response>/);
    assert.match(
      xml,
      /<Stream[^>]*>wss:\/\/clickai\.test\/api\/public\/media-stream\/vobiz<\/Stream>/,
    );
    assert.match(xml, /<\/Response>$/);
  });

  test("requests bidirectional mu-law 8kHz audio, matching VobizMediaBridge's native format", () => {
    const xml = buildVobizStreamXml("wss://clickai.test/ws");
    assert.match(xml, /bidirectional="true"/);
    assert.match(xml, /contentType="audio\/x-mulaw;rate=8000"/);
  });

  test("escapes XML-special characters in the URL rather than injecting them raw", () => {
    const xml = buildVobizStreamXml("wss://clickai.test/ws?a=1&b=2");
    assert.match(xml, /a=1&amp;b=2/);
    assert.doesNotMatch(xml, /a=1&b=2/);
  });
});

describe("buildVobizDeniedXml", () => {
  test("speaks the message and returns no <Stream> — Vobiz never opens media for a denied call", () => {
    const xml = buildVobizDeniedXml("This call cannot be connected right now.");
    assert.match(xml, /<Speak[^>]*>This call cannot be connected right now\.<\/Speak>/);
    assert.doesNotMatch(xml, /<Stream/);
  });

  test("escapes XML-special characters in the message", () => {
    const xml = buildVobizDeniedXml(`Tom & Jerry's "test" <call>`);
    assert.doesNotMatch(xml, /<call>/);
    assert.match(xml, /Tom &amp; Jerry&apos;s &quot;test&quot; &lt;call&gt;/);
  });
});
