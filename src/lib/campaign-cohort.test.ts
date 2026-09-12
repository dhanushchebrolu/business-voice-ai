import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildCohortPayload } from "./campaign-cohort.ts";

/**
 * Provider contract test (spec "FOURTH"): proves the exact CSV +
 * transformation payload Klyro would send for a known input row matches
 * what the AI is expected to receive — using the spec's own example:
 *
 *   name,phone,appointment_date,doctor,amount
 *   Rahul,+919876543210,15 Sep,Dr Rao,500
 *
 * mapped (via campaign.variable_mapping, applied upstream at enrollment
 * time — see contacts-import.ts's applyVariableMapping) to:
 *
 *   customer_name = Rahul
 *   appointment_date = 15 Sep
 *   doctor_name = Dr Rao
 *   amount = 500
 */
describe("buildCohortPayload — provider contract", () => {
  test("produces the exact CSV columns and row Sarvam's cohort upload expects", () => {
    const payload = buildCohortPayload([
      {
        campaignContactId: "cc-1",
        phone: "+919876543210",
        variables: {
          customer_name: "Rahul",
          appointment_date: "15 Sep",
          doctor_name: "Dr Rao",
          amount: "500",
        },
      },
    ]);

    const [header, row] = payload.csvText.split("\n");
    assert.equal(header, "phone,user_identifier,amount,appointment_date,customer_name,doctor_name");
    assert.equal(row, "+919876543210,cc-1,500,15 Sep,Rahul,Dr Rao");
  });

  test("maps app_variable_columns as an identity mapping onto Klyro-generated column names", () => {
    const payload = buildCohortPayload([
      { campaignContactId: "cc-1", phone: "+919876543210", variables: { customer_name: "Rahul" } },
    ]);
    assert.deepEqual(payload.transformation, {
      phoneNumberColumn: "phone",
      userIdentifierColumn: "user_identifier",
      appVariableColumns: { customer_name: "customer_name" },
    });
  });

  test("embeds campaign_contacts.id as user_identifier for every row, not the phone number or an array index", () => {
    const payload = buildCohortPayload([
      { campaignContactId: "cc-a", phone: "+919876543210", variables: {} },
      { campaignContactId: "cc-b", phone: "+919876543211", variables: {} },
    ]);
    const rows = payload.csvText.split("\n").slice(1);
    assert.equal(rows[0]?.split(",")[1], "cc-a");
    assert.equal(rows[1]?.split(",")[1], "cc-b");
  });

  test("quotes a variable value containing a comma so the CSV stays parseable", () => {
    const payload = buildCohortPayload([
      { campaignContactId: "cc-1", phone: "+919876543210", variables: { doctor_name: "Rao, Dr" } },
    ]);
    assert.match(payload.csvText, /"Rao, Dr"/);
  });

  test("fills a missing variable for one row as an empty cell rather than misaligning columns", () => {
    const payload = buildCohortPayload([
      { campaignContactId: "cc-1", phone: "+919876543210", variables: { customer_name: "Rahul" } },
      { campaignContactId: "cc-2", phone: "+919876543211", variables: {} },
    ]);
    const rows = payload.csvText.split("\n").slice(1);
    // header: phone,user_identifier,customer_name
    assert.equal(rows[1], "+919876543211,cc-2,");
  });
});
