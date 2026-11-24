import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The campaign wizard (components/app/CampaignWizard.tsx), used to create a
 * campaign (/app/campaigns/new) and to edit one (/app/campaigns/$id/edit).
 * Saving writes configuration only, through the server function; it never
 * launches, dials or touches dispatch.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(join(here, ...p), "utf8").replace(/\r\n/g, "\n");
const wizard = read("..", "components", "app", "CampaignWizard.tsx");
const newRoute = read("app.campaigns.new.tsx");
const editRoute = read("app.campaigns.$campaignId_.edit.tsx");
const layout = read("app.campaigns.tsx");
const index = read("app.campaigns.index.tsx");
const tree = read("..", "routeTree.gen.ts");
const saveFn = wizard.slice(
  wizard.indexOf("async function save("),
  wizard.indexOf("\n  function cancel()"),
);
const cancelFn = wizard.slice(
  wizard.indexOf("\n  function cancel()"),
  wizard.indexOf("\n  const set ="),
);

describe("campaign routes", () => {
  test("/app/campaigns is a layout that renders its children through an Outlet", () => {
    assert.match(layout, /createFileRoute\("\/app\/campaigns"\)/);
    assert.match(layout, /<Outlet \/>/);
  });

  test("list, wizard, detail and edit are all routes under the campaigns layout", () => {
    assert.match(index, /createFileRoute\("\/app\/campaigns\/"\)/);
    assert.match(tree, /'\/app\/campaigns\/': typeof AppCampaignsIndexRoute/);
    assert.match(tree, /'\/app\/campaigns\/new': typeof AppCampaignsNewRoute/);
    assert.match(tree, /'\/app\/campaigns\/\$campaignId': typeof AppCampaignsCampaignIdRoute/);
    assert.match(
      tree,
      /'\/app\/campaigns\/\$campaignId\/edit': typeof AppCampaignsCampaignIdEditRoute/,
    );
  });

  test("the list links to the wizard from the header and from the empty state", () => {
    assert.match(index, /<Link to="\/app\/campaigns\/new">/);
    assert.match(index, /action=\{createButton\}/);
  });

  test("create and edit render the same wizard", () => {
    assert.match(newRoute, /<CampaignWizard mode="create" \/>/);
    assert.match(editRoute, /mode="edit"/);
    assert.match(editRoute, /initial=\{wizardStateFromCampaign\(campaign\)\}/);
  });
});

describe("saving never dials", () => {
  test("no launch, dispatch or outbound-call function is reachable from the wizard", () => {
    for (const src of [wizard, newRoute, editRoute])
      assert.doesNotMatch(
        src,
        /launchCampaign|resumeCampaign|dispatch|createInstantOutbound|testSarvamOutboundCall/,
      );
  });

  test("the final step offers two saves and Cancel, never a launch action", () => {
    assert.match(wizard, /Save as draft/);
    assert.match(wizard, /"Save changes" : "Save campaign"/);
    assert.match(wizard, /onClick=\{cancel\}/);
    assert.doesNotMatch(wizard, /<Button[^>]*>[^<]*(Launch|Start dialing|Start calls)/);
  });

  test("the configuration is saved by the server function, never by a direct table write", () => {
    assert.match(saveFn, /await saveCampaignConfiguration\(\{/);
    assert.doesNotMatch(wizard, /from\("campaigns"\)/);
  });
});

describe("Save as draft and Save campaign", () => {
  test("both send the whole configuration; only confirm differs", () => {
    assert.match(saveFn, /campaignId: p\.campaignId,\s*wizard: state,\s*confirm: !asDraft,/);
    assert.match(saveFn, /organizationId: orgId,\s*wizard: state,\s*confirm: !asDraft,/);
    assert.doesNotMatch(saveFn, /saveCampaignContext/);
  });

  test("a create carries this session's idempotency key; an edit (campaignId) never does", () => {
    assert.match(saveFn, /\.\.\.\(createKey \? \{ idempotencyKey: createKey \} : \{\}\)/);
    const editBranch = saveFn.slice(
      saveFn.indexOf("? { campaignId: p.campaignId"),
      saveFn.indexOf(": {"),
    );
    assert.doesNotMatch(editBranch, /idempotencyKey/);
    assert.match(wizard, /useState\(\(\) => \(editing \? null : claimCampaignCreateKey\(\)\)\)/);
    assert.match(wizard, /return \(\) => releaseCampaignCreateKey\(\);/);
  });

  test("a draft does not need an agent; Save campaign does", () => {
    assert.match(wizard, /requireAgent: false/);
    assert.match(saveFn, /if \(!asDraft && !agentConfigId\)/);
  });
});

describe("no duplicate campaign on a double click or a retry", () => {
  test("a save in flight ignores further clicks and both save buttons are disabled", () => {
    assert.match(saveFn, /if \(saving \|\| !orgId\) return;/);
    assert.equal((wizard.match(/disabled=\{saving\}\s+onClick=\{\(\) => save\(/g) ?? []).length, 2);
  });

  test("after the first save the campaign id is reused, so a retry updates instead of creating", () => {
    assert.match(saveFn, /p\.campaignId\s*\?\s*\{\s*campaignId: p\.campaignId/);
    // ...and an edit sends the version it last saw, so a stale save is refused.
    assert.match(saveFn, /expectedUpdatedAt: p\.updatedAt/);
    assert.match(saveFn, /p\.updatedAt = saved\.updatedAt;/);
    assert.match(saveFn, /p\.campaignId = saved\.campaignId;/);
    assert.match(wizard, /campaignId: campaignId \?\? null/);
    assert.match(saveFn, /if \(!editing && !p\.contactsImported && audienceTable\.rows\.length\)/);
  });

  test("the saving flag is cleared on every outcome, and errors use describeQueryError", () => {
    assert.match(saveFn, /setSaving\(true\);\s*\n\s*try \{/);
    assert.match(saveFn, /\} catch \(err\) \{[\s\S]*?toast\.error\(\s*\n\s*describeQueryError\(/);
    // A conflict is shown as its own notice, never merged or retried automatically.
    assert.match(
      saveFn,
      /\/changed elsewhere\/\.test\([\s\S]*?setConflict\(true\);\s*\n\s*return;/,
    );
    assert.match(saveFn, /\} finally \{\s*\n\s*setSaving\(false\);/);
  });

  test("every visible step is re-validated before saving", () => {
    assert.match(saveFn, /for \(const i of visibleSteps\) \{/);
    assert.match(saveFn, /stepErrors\(i\)/);
  });
});

describe("editing", () => {
  test("edit hides the contacts step (contacts are managed on the campaign page) and never imports", () => {
    assert.match(wizard, /filter\(\(i\) => i !== AUDIENCE_STEP\)/);
    assert.match(saveFn, /!editing && !p\.contactsImported/);
  });

  test("Cancel only navigates away: it never saves", () => {
    // The confirm text says "Nothing has been saved", so look for calls, not the word.
    assert.doesNotMatch(
      cancelFn,
      /\bsave\(|saveCampaignConfiguration|importCampaignContactsCsv|supabase/,
    );
    assert.match(
      cancelFn,
      /navigate\(\{ to: "\/app\/campaigns\/\$campaignId", params: \{ campaignId \} \}\)/,
    );
  });

  test("the edit page refuses campaigns whose status can't be edited", () => {
    assert.match(editRoute, /const blocked = configEditBlockedReason\(campaign\.status\);/);
    assert.match(editRoute, /if \(blocked\)/);
  });

  test("only this workspace's outbound-enabled numbers are offered, and none is explained", () => {
    assert.match(wizard, /\(numbers \?\? \[\]\)\.filter\(isEligibleCallerNumber\)/);
    assert.match(wizard, /None of your numbers is enabled for outbound calling yet/);
    assert.match(wizard, /Choosing a number does not start any calls\./);
  });

  test("released numbers are not listed as 'cannot call out'; other ineligible numbers are, with their reason", () => {
    const block = wizard.slice(
      wizard.indexOf("const ineligibleNumbers ="),
      wizard.indexOf("const businessName"),
    );
    assert.match(block, /if \(n\.status === "released"\) return \[\];/);
    assert.match(block, /const reason = callerNumberIneligibility\(n\);/);
    assert.ok(
      block.indexOf('n.status === "released"') < block.indexOf("callerNumberIneligibility(n)"),
      "released numbers are dropped before the reason is computed",
    );
  });
});

describe("unsaved changes are not lost by accident", () => {
  test("leaving with unsaved changes asks first, in the app and on reload or close", () => {
    assert.match(wizard, /useBlocker\(\{/);
    assert.match(wizard, /enableBeforeUnload: \(\) => dirty && !leaving\.current/);
  });

  test("a successful save or a confirmed cancel leaves without asking again", () => {
    assert.match(saveFn, /leaving\.current = true;\s*\n\s*navigate\(/);
    assert.match(cancelFn, /leaving\.current = true;/);
  });

  test("the contacts import still needs the user's review", () => {
    assert.match(wizard, /validateAudience\(audienceTable, audience, reviewed\)/);
    assert.ok((wizard.match(/setReviewed\(false\)/g) ?? []).length >= 5);
  });
});

describe("campaign instructions stay on the campaign", () => {
  test("the wizard never writes the agent's own configuration", () => {
    assert.doesNotMatch(wizard, /from\("agent_configs"\)\s*\n?\s*\.(update|insert|upsert)/);
  });

  test("agents offered are only the organization's own (RLS-scoped client, organization filter)", () => {
    assert.match(
      wizard,
      /\.from\("agent_configs"\)\s*\n\s*\.select\("id, agent_name"\)\s*\n\s*\.eq\("organization_id", orgId!\)/,
    );
  });
});
