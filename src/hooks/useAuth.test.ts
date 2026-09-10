import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Production incident regression coverage: a Supabase misconfiguration (or
 * any other reason `supabase.auth.*` might throw/reject) must degrade
 * AuthProvider to "signed out," never crash the whole app.
 *
 * `AuthProvider` wraps every route via __root.tsx — including the public
 * marketing site, which must never require Supabase to be configured
 * correctly just to render. There is no DOM-rendering test setup in this
 * repo (no React Testing Library/jsdom — see service-lock-message.test.ts's
 * own note), so this is a source-scan of the hook's structure, matching the
 * convention already used throughout this codebase for logic that can't be
 * rendered directly by Node's built-in test runner.
 */

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "useAuth.tsx"), "utf8");

function extractEffect(): string {
  const start = src.indexOf("useEffect(() => {");
  const end = src.indexOf("}, []);", start);
  assert.ok(start > -1 && end > -1, "expected to find AuthProvider's session-resolution effect");
  return src.slice(start, end);
}

describe("AuthProvider — a Supabase failure degrades to signed-out, never an uncaught throw", () => {
  test("the synchronous supabase.auth.onAuthStateChange call (which can throw the moment the lazy client Proxy is first touched) is wrapped in try/catch", () => {
    const effect = extractEffect();
    const tryIdx = effect.indexOf("try {");
    const onAuthChangeIdx = effect.indexOf("supabase.auth.onAuthStateChange(");
    const catchIdx = effect.indexOf("} catch (error) {");
    assert.ok(tryIdx > -1 && onAuthChangeIdx > -1 && catchIdx > -1);
    assert.ok(
      tryIdx < onAuthChangeIdx && onAuthChangeIdx < catchIdx,
      "onAuthStateChange must be inside the try block",
    );
  });

  test("a synchronous failure sets session to null and loading to false — never leaves loading stuck true, never rethrows", () => {
    const effect = extractEffect();
    const catchIdx = effect.indexOf("} catch (error) {");
    const catchBlock = effect.slice(catchIdx);
    assert.match(catchBlock, /setSession\(null\)/);
    assert.match(catchBlock, /setLoading\(false\)/);
    assert.doesNotMatch(catchBlock, /throw /);
  });

  test("getSession()'s promise chain has a .catch — an async rejection (e.g. a network/config failure after the client constructed) also resolves to signed-out, not an unhandled rejection", () => {
    const effect = extractEffect();
    const getSessionIdx = effect.indexOf(".getSession()");
    const unsubscribeIdx = effect.indexOf("return () => sub.subscription.unsubscribe();");
    assert.ok(getSessionIdx > -1 && unsubscribeIdx > -1 && getSessionIdx < unsubscribeIdx);
    const chainBlock = effect.slice(getSessionIdx, unsubscribeIdx);
    assert.match(chainBlock, /\.catch\(/);
    const catchChainIdx = chainBlock.indexOf(".catch(");
    const catchChainBlock = chainBlock.slice(catchChainIdx);
    assert.match(catchChainBlock, /setSession\(null\)/);
    assert.match(catchChainBlock, /setLoading\(false\)/);
  });

  test("no error message reaching console.error includes an env var VALUE — only the thrown Error's message (variable names, per client.ts) is logged, the raw env object is never referenced here", () => {
    const effect = extractEffect();
    assert.doesNotMatch(effect, /process\.env/);
    assert.doesNotMatch(effect, /import\.meta\.env/);
  });
});

describe("AuthProvider — protected routes stay fail-safe, not fail-open, when this catch fires", () => {
  test("app.tsx and admin.tsx both redirect to /auth on session:null — a caught Supabase failure denies access to protected routes exactly like a real signed-out visitor, never grants it", () => {
    const routesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");
    for (const file of ["app.tsx", "admin.tsx"]) {
      const routeSrc = readFileSync(join(routesDir, file), "utf8");
      assert.match(
        routeSrc,
        /if \(!loading && !session\) navigate\(\{ to: "\/auth" \}\)/,
        `${file} must still redirect unauthenticated/unresolved sessions to /auth`,
      );
    }
  });
});
