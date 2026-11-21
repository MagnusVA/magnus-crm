import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { setTimeout } from "node:timers/promises";

const exec = promisify(execFile);
const productionSubstring = "usable-guineapig-697";
const orgId = "org_whop_race_fixture";
const eventType = "https://api.calendly.com/event_types/whop-race-fixture";
const owner = { subject: "user_whop_race_owner", org_id: orgId };
const closer = { subject: "user_whop_race_closer", org_id: orgId };
const runId = randomUUID().slice(0, 8);
const commonAmount = { amount: 123, currency: "USD", paymentType: "pif" };
const writers = ["meeting", "reminder", "side_deal", "additional"];

const { values } = parseArgs({
  options: {
    deployment: { type: "string" },
    rounds: { type: "string", default: "3" },
    "i-understand-this-writes-test-rows": { type: "boolean" },
  },
});
const name = values.deployment;
const rounds = Number(values.rounds);
assert(values["i-understand-this-writes-test-rows"] && name,
  "Pass --deployment <canonical dev name> and --i-understand-this-writes-test-rows. See runbooks/whop-concurrency.md.");
assert.match(name, /^[a-z][a-z0-9-]+-\d+$/, "Use the canonical Convex deployment name, such as lively-jay-123.");
assert(Number.isInteger(rounds) && rounds >= 2 && rounds <= 10, "--rounds must be an integer from 2 to 10.");

const url = new URL(`https://${name}.convex.cloud`);
assert(!url.href.includes(productionSubstring), "The requested URL contains the production deployment name.");

function cli(args, { verbose = false, timeout = 60_000 } = {}) {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.CONVEX_VERBOSE;
  if (verbose) env.CONVEX_VERBOSE = "1";
  return exec("npx", ["convex", ...args, "--deployment", name], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout, env,
  });
}

async function run(name, args, identity, options) {
  const input = ["run", name, JSON.stringify(args)];
  if (identity) input.push("--identity", JSON.stringify(identity));
  const { stdout } = await cli(input, options);
  return JSON.parse(stdout.trim() || "null");
}

async function read(source) {
  const { stdout } = await cli(["run", "--inline-query", source]);
  return JSON.parse(stdout.trim());
}

async function verifyDestination() {
  // Use the CLI's resolved endpoint and type. This probe runs one read-only
  // query, before any setup, upload or mutation.
  const { stderr } = await cli(["run", "--inline-query", "return true"], { verbose: true })
    .catch(() => { throw new Error("Could not verify the named deployment. Check your Convex CLI login and deployment name."); });
  const resolved = stderr.match(/Deployment URL: (\S+?), Deployment Name: (\S+?), Deployment Type: (\w+)/);
  assert(resolved, "The Convex CLI did not report the resolved deployment. Stop and check the CLI version.");
  const [, resolvedUrl, resolvedName, type] = resolved;
  assert(!resolvedUrl.toLowerCase().includes(productionSubstring), "The resolved URL contains the production deployment name.");
  assert.equal(type, "dev", "The resolved deployment must be dev.");
  assert.equal(resolvedName, name, "The resolved deployment has a different name.");
  assert.equal(new URL(resolvedUrl).href, url.href, "The resolved URL has a different origin.");
}

const isSyntheticEmail = (value) => typeof value === "string" && value.endsWith("@example.com");

async function verifySeed() {
  const snapshot = await run("testing/operationalData:getSnapshot", {});
  const allowed = { tenants: 1, users: 2, tenantPrograms: 1, eventTypeConfigs: 1 };
  for (const [table, count] of Object.entries(snapshot.counts)) {
    assert.equal(count, Object.hasOwn(allowed, table) ? allowed[table] : 0,
      `Unexpected seed count in ${table}. Use a fresh deployment with only the runbook's setup rows.`);
  }
  const tenant = await run("testing/e2e:getTenantByWorkosOrgId", { workosOrgId: orgId });
  assert(tenant?.companyName === "Whop race fixture" && tenant.contactEmail === "whop-race@example.com" &&
    tenant.status === "active" && tenant.billingOpsEnabled, "Synthetic tenant or Billing Ops setup is missing.");
  const users = await run("testing/e2e:getTestUserMap", { tenantId: tenant.tenantId });
  assert(users.every((user) => user.isActive && isSyntheticEmail(user.email)), "Expected active example.com fixture users.");
  const closerUser = users.find((user) => user.role === "closer" && user.email === "whop-closer@example.com");
  assert(closerUser?.calendlyUserUri === "https://api.calendly.com/users/whop-race-fixture",
    "The fixture closer must have the fake Calendly host URI.");
  assert(users.some((user) => user.role === "tenant_master" && user.email === "whop-owner@example.com"),
    "Synthetic owner is missing.");
  const setup = await read(`
    const [tenant, configs, programs, search, files] = await Promise.all([
      ctx.db.get("tenants", ${JSON.stringify(tenant.tenantId)}),
      ctx.db.query("eventTypeConfigs").take(2),
      ctx.db.query("tenantPrograms").take(2),
      ctx.db.query("leadCustomerSearchRows").take(1),
      ctx.db.system.query("_storage").take(1),
    ]);
    return {
      automationConfigured: tenant?.resultAutomation !== undefined,
      configs, programs, hasSearch: search.length > 0, hasStorage: files.length > 0,
    };
  `);
  assert(!setup.automationConfigured && !setup.hasSearch && !setup.hasStorage,
    "Expected a fresh seed with no settings, search rows or files.");
  const [program] = setup.programs;
  const [config] = setup.configs;
  assert(program?.tenantId === tenant.tenantId && config?.tenantId === tenant.tenantId &&
    config.calendlyEventTypeUri === eventType && config.bookingProgramMappingStatus === "mapped" &&
    config.bookingProgramId === program._id, "The fixture event type must map to the fixture program.");
  return { tenantId: tenant.tenantId, closerUser, programId: program._id };
}

async function keepSweepIdle(connectionId) {
  // Hold the existing lease so the periodic sweep does not call Whop with
  // test credentials. The lease expires if this process is interrupted.
  const lease = await run("payments/connectionState:takeSweepLease", { connectionId, token: runId });
  assert.equal(lease, "acquired", "Could not reserve the sandbox sweep lease.");
}

async function prepareWhop() {
  const accountId = `biz_race_${runId}`;
  const connectionId = await run("payments/connection:saveConnection", {
    accountId, environment: "sandbox", apiKey: "api_whop_fake_race_fixture", disputeAccess: "ok",
  }, owner);
  await keepSweepIdle(connectionId);
  const connection = await run("payments/connection:getConnection", { environment: "sandbox" }, owner);
  assert(connection?.connectionId === connectionId && connection.accountId === accountId && connection.status === "connected");
  await run("automation/settings:setEnabled", { enabled: true }, owner);
  for (const kind of ["payment_win", "additional_payment"]) {
    await run("automation/settings:setKindMode", { kind, mode: "ask" }, owner);
  }
  return { connectionId, accountId, connectedAt: connection.connectedAt };
}

async function book({ tenantId, closerUser }, key, email) {
  const eventUri = `https://api.calendly.com/scheduled_events/whop-race-${key}`;
  const inviteeUri = `${eventUri}/invitees/person`;
  const now = Date.now();
  const payload = {
    uri: inviteeUri, email, name: "Synthetic Whop Race",
    scheduled_event: {
      uri: eventUri,
      event_type: eventType,
      start_time: new Date(now - 35 * 60_000).toISOString(),
      end_time: new Date(now - 5 * 60_000).toISOString(),
      event_memberships: [{ user: closerUser.calendlyUserUri, user_email: closerUser.email }],
    },
  };
  const receipt = await run("webhooks/calendlyMutations:persistRawEvent", {
    tenantId, calendlyEventUri: inviteeUri, eventType: "invitee.created",
    payload: JSON.stringify({ created_at: new Date(now - 60 * 60_000).toISOString(), payload }),
  });
  assert(receipt, "Expected a new booking receipt.");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await run("testing/e2e:getBookingResultByInviteeEmail", { tenantId, inviteeEmail: email });
    if (state?.meeting?.calendlyInviteeUri === inviteeUri) {
      assert.equal(state.opportunity.assignedCloserId, closerUser.userId);
      assert.equal(state.meeting.status, "scheduled");
      return { opportunityId: state.opportunity.id, meetingId: state.meeting.id };
    }
    await setTimeout(500);
  }
  throw new Error(`Synthetic booking did not apply for ${key}. Check its webhook delivery in the dev dashboard.`);
}

async function proof() {
  const upload = new URL(await run("closer/payments:generateUploadUrl", {}, closer));
  assert.equal(upload.origin, url.origin, "Unexpected proof upload destination.");
  assert(!upload.href.toLowerCase().includes(productionSubstring));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/7sAAAAASUVORK5CYII=", "base64");
  const response = await fetch(upload, {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: Buffer.concat([png, Buffer.from(randomUUID())]),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  assert(response.ok, `Synthetic proof upload failed with HTTP ${response.status}.`);
  const { storageId } = await response.json();
  assert(storageId, "Proof upload did not return a storage ID.");
  return storageId;
}

async function prepareStore(connection, key, email) {
  await keepSweepIdle(connection.connectionId);
  const externalPaymentId = `pay_race_${key}`;
  const identity = { ...connection, externalPaymentId };
  const now = Date.now();
  const generation = await run("payments/intake:beginPaymentRead", identity);
  assert(Number.isInteger(generation), "Could not start the canonical read.");
  return {
    externalPaymentId,
    store: () => run("payments/intake:storePaymentRead", {
      ...identity, generation,
      payment: {
        externalPaymentId, status: "paid", sourceCreatedAt: now, sourceUpdatedAt: now, paidAt: now,
        totalMinor: commonAmount.amount * 100, currency: "USD", decimals: 2, refundedMinor: 0, adverseState: "none",
        billingReason: "one_time", lineItemCount: 1, failedAttemptCount: 0, payerEmail: email,
      },
    }),
  };
}

async function state() {
  return read(`
    const [facts, records, deals] = await Promise.all([
      ctx.db.query("providerPayments").take(101),
      ctx.db.query("paymentRecords").take(101),
      ctx.db.query("opportunities").take(101),
    ]);
    return { facts, records, deals };
  `);
}

function checkState({ facts, records, deals }, tenantId, withoutAllocation) {
  for (const rows of [facts, records, deals]) {
    assert(rows.length <= 100, "Race verification exceeded its read limit.");
    assert(rows.every((row) => row.tenantId === tenantId), "Found a row outside the fixture tenant.");
  }
  const counting = records.filter((row) => row.status !== "disputed");
  for (const row of counting) {
    if (!row.providerPaymentId) continue;
    assert.equal(facts.find((fact) => fact._id === row.providerPaymentId)?.paymentRecordId, row._id,
      `CRM payment ${row._id} has no reciprocal active pointer.`);
  }
  for (const fact of facts) {
    assert(fact.externalPaymentId.startsWith(`pay_race_${runId}_`), "Found a Whop fact outside this run.");
    const active = counting.filter((row) => row.providerPaymentId === fact._id);
    const expected = fact.externalPaymentId === withoutAllocation ? [] : [fact.paymentRecordId];
    assert.deepEqual(active.map((row) => row._id), expected, `Unexpected counting rows for ${fact.externalPaymentId}.`);
    assert.equal(fact.paymentRecordId, active[0]?._id);
    if (active[0]) {
      assert.equal(active[0].opportunityId, fact.opportunityId);
      assert(["linked", "recorded"].includes(fact.reviewState));
    } else {
      assert(!["linked", "recorded"].includes(fact.reviewState));
    }
  }
  for (const deal of deals) {
    const onDeal = counting.filter((row) => row.opportunityId === deal._id);
    assert.equal(deal.outcome === "won", onDeal.length > 0, `Cash and outcome diverged for deal ${deal._id}.`);
    assert.equal(deal.paymentReceivedAt, onDeal.length ? Math.min(...onDeal.map((row) => row.recordedAt)) : undefined);
  }
  return counting;
}

function factFor({ facts }, externalPaymentId) {
  const fact = facts.find((fact) => fact.externalPaymentId === externalPaymentId);
  assert(fact, `Missing stored fact for ${externalPaymentId}.`);
  return fact;
}

function errorText(error) {
  return String(error?.stderr || error?.message || error).trim();
}

function checkConflict(outcome) {
  assert(outcome.status === "rejected");
  if (!errorText(outcome.reason).includes("payment.whop_payment_found")) throw outcome.reason;
}

async function manualWriterRace(setup, connection, round, writer) {
  const key = `${runId}_${round}_${writer}`;
  const email = `whop-${key.replaceAll("_", "-")}@example.com`;
  let target;
  if (writer === "side_deal") {
    target = await run("opportunities/createManual:createManual", {
      clientRequestId: key, newLeadInput: { fullName: "Synthetic Side Deal", email },
    }, closer);
  } else {
    target = await book(setup, key, email);
  }
  const { opportunityId, meetingId } = target;
  const { programId, tenantId } = setup;
  const before = await run("testing/e2e:getOpportunitySnapshot", { opportunityId });
  assert.equal(before.payments.length, 0);

  const proofFileId = await proof();
  const first = { ...commonAmount, proofFileId, opportunityId, programId };
  let write;
  switch (writer) {
    case "meeting":
      write = (provider) => run("closer/payments:logPayment", { ...first, meetingId, provider }, closer);
      break;
    case "reminder": {
      const { followUpId } = await run("closer/followUpMutations:createManualReminderFollowUpPublic", {
        opportunityId, meetingId, contactMethod: "call", reminderScheduledAt: Date.now() + 3_600_000,
      }, closer);
      write = (provider) => run("closer/reminderOutcomes:logReminderPayment", {
        ...commonAmount, programId, proofFileId, followUpId, provider,
      }, closer);
      break;
    }
    case "side_deal":
      write = (provider) => run("sideDeals/logPayment:logPayment", { ...first, provider }, closer);
      break;
    case "additional":
      await run("closer/payments:logPayment", {
        ...commonAmount, amount: 200, opportunityId, meetingId, programId,
      }, owner);
      write = (provider) => run("closer/additionalPayment:recordAdditionalPayment", {
        ...commonAmount, paymentType: "split", proofFileId, opportunityId, provider,
      }, closer);
      break;
    default:
      throw new Error(`Unknown writer ${writer}`);
  }

  const { externalPaymentId, store } = await prepareStore(connection, key, email);
  const [providerWrite, manualWrite] = await Promise.allSettled([store(), write()]);
  if (providerWrite.status === "rejected") throw providerWrite.reason;
  assert.equal(providerWrite.value, "stored");

  const afterRace = await state();
  const fact = factFor(afterRace, externalPaymentId);
  assert.equal(fact.status, "paid");
  const counting = checkState(afterRace, tenantId, externalPaymentId);
  const sameAmount = counting.filter((row) =>
    row.opportunityId === opportunityId && row.amountMinor === commonAmount.amount * 100);
  let outcome;
  if (manualWrite.status === "fulfilled") {
    assert.equal(sameAmount.length, 1, `The ${writer} save must create exactly one CRM payment.`);
    await run("payments/review:linkToPaymentRecord", {
      providerPaymentId: fact._id, paymentRecordId: sameAmount[0]._id, expectedAllocationRevision: fact.allocationRevision,
    }, owner);
    outcome = "save committed; Billing linked";
  } else {
    checkConflict(manualWrite);
    assert.equal(sameAmount.length, 0, "The prompted save must leave no CRM payment.");
    await write({
      kind: "same_money", providerPaymentId: fact._id,
      expectedAllocationRevision: fact.allocationRevision, acknowledgeAmountDifference: false,
    });
    outcome = "save prompted; retry linked";
  }

  const final = await state();
  const finalCounting = checkState(final, tenantId);
  assert.equal(finalCounting.filter((row) => row.opportunityId === opportunityId).length, writer === "additional" ? 2 : 1);
  assert.equal(factFor(final, externalPaymentId).reviewState, "linked");
  return outcome;
}

function resultLabel(outcome) {
  if (outcome.status === "rejected") {
    return errorText(outcome.reason).match(/payment\.[a-z_]+/)?.[0] ?? "CLI error";
  }
  const result = outcome.value;
  if (result?.ok === false) return result.code;
  return result?.alreadyApplied ? "already applied" : "committed";
}

async function correctionRaces(setup, connection, round, rows) {
  const key = `${runId}_${round}_confirm`;
  const email = `whop-${key.replaceAll("_", "-")}@example.com`;
  const { opportunityId, meetingId } = await book(setup, key, email);
  const { tenantId, programId } = setup;
  const { externalPaymentId, store } = await prepareStore(connection, key, email);
  assert.equal(await store(), "stored");
  const fact = factFor(await state(), externalPaymentId);
  const target = { providerPaymentId: fact._id, opportunityId };
  const { preview, waiting } = await run("payments/confirm:previewWhopConfirm", target, owner);
  assert(preview?.ok && waiting?.waitsOn === "billing", "The unmapped fact must allow Billing confirmation without a closer reservation.");
  const revision = { expectedAllocationRevision: preview.allocationRevision };
  const confirmationResults = await Promise.allSettled([
    run("payments/confirm:confirmWhopPayment", {
      ...target, ...revision, expectedFingerprint: preview.fingerprint, programId, paymentType: "pif",
    }, owner),
    run("closer/payments:logPayment", {
      ...commonAmount, programId, meetingId, opportunityId,
      provider: { kind: "confirm", providerPaymentId: fact._id, ...revision },
    }, closer),
  ]);
  rows.push({ round, race: "Billing / closer confirm", outcome: confirmationResults.map(resultLabel).join(" / ") });
  const [billing, closing] = confirmationResults;
  if (billing.status === "rejected") throw billing.reason;
  if (!billing.value.ok) assert(["stale_preview", "reallocated"].includes(billing.value.code), "Unexpected Billing refusal.");
  if (closing.status === "rejected") checkConflict(closing);

  const afterConfirm = await state();
  const confirmed = checkState(afterConfirm, tenantId).filter((row) => row.opportunityId === opportunityId);
  assert.equal(confirmed.length, 1, "Confirm race must leave exactly one CRM payment on the deal.");
  const paymentRecordId = confirmed[0]._id;
  assert.equal(factFor(afterConfirm, externalPaymentId).paymentRecordId, paymentRecordId);

  const exclusion = { paymentRecordId, cause: "wrong_match" };
  const toExclude = await run("payments/exclude:previewExclusion", exclusion, owner);
  assert(!toExclude.refusal && toExclude.dispositionRequired);
  const excludeArgs = { ...exclusion, level: "reviewed", disposition: "lost", expectedFingerprint: toExclude.fingerprint };
  const duplicate = await Promise.allSettled([
    run("payments/exclude:excludePayment", excludeArgs, owner),
    run("payments/exclude:excludePayment", excludeArgs, owner),
  ]);
  rows.push({ round, race: "same exclusion fingerprint", outcome: duplicate.map(resultLabel).join(" / ") });
  const [left, right] = duplicate.map((result) => {
    if (result.status === "rejected") throw result.reason;
    assert(result.value.ok, "Both exclusions must return success.");
    return result.value;
  });
  assert.equal(left.correctionId, right.correctionId);
  assert.notEqual(left.alreadyApplied, right.alreadyApplied);
  checkState(await state(), tenantId, externalPaymentId);

  // Once excluded, another exclusion needs a different fingerprint. The stale
  // request must lose whether Convex schedules it before or after the restore.
  const stale = await run("payments/exclude:previewExclusion", exclusion, owner);
  assert.equal(stale.refusal, "stale_preview");
  assert.notEqual(stale.fingerprint, toExclude.fingerprint);
  const restoreTarget = { correctionId: left.correctionId };
  const toRestore = await run("payments/restore:previewRestore", restoreTarget, owner);
  assert.equal(toRestore.result, "restored_won");
  const competing = await Promise.allSettled([
    run("payments/exclude:excludePayment", { ...excludeArgs, expectedFingerprint: stale.fingerprint }, owner),
    run("payments/restore:restorePayment", { ...restoreTarget, expectedFingerprint: toRestore.fingerprint }, owner),
  ]);
  rows.push({ round, race: "exclusion / restore", outcome: competing.map(resultLabel).join(" / ") });
  for (const result of competing) if (result.status === "rejected") throw result.reason;
  assert.deepEqual(competing[0].value, { ok: false, code: "stale_preview" });
  assert(competing[1].value.ok && !competing[1].value.alreadyApplied, "Restore must commit once.");
  const final = await state();
  checkState(final, tenantId);
  assert.equal(factFor(final, externalPaymentId).paymentRecordId, paymentRecordId);
}

async function cleanup(tenantId) {
  await verifyDestination();
  const tenantIds = await read('return (await ctx.db.query("tenants").take(2)).map((tenant) => tenant._id)');
  assert.deepEqual(tenantIds, [tenantId], "The fixture is no longer the only tenant. Inspect the deployment before deleting any data.");
  const confirmation = "DELETE_OPERATIONAL_DATA";
  const reset = await run("testing/operationalData:resetOperationalData", {
    confirmation, dryRun: false,
  }, undefined, { timeout: 180_000 });
  assert.equal(reset.mode, "executed");
  assert.equal(reset.after.totals.operational, 0, "Operational reset left rows behind.");
  // The existing reset does not cover this projection.
  const count = 'return (await ctx.db.query("leadCustomerSearchRows").take(101)).length';
  if (await read(count)) {
    const directory = await mkdtemp(join(tmpdir(), "whop-race-cleanup-"));
    try {
      const empty = join(directory, "empty.json");
      await writeFile(empty, "[]\n");
      await cli(["import", "--replace", "--yes", "--table", "leadCustomerSearchRows", empty]);
      assert.equal(await read(count), 0, "Search projection cleanup left rows behind.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const storageRemains = await read('return (await ctx.db.system.query("_storage").take(1)).length');
  assert.equal(storageRemains, 0, "A proof upload is still in storage. Discard the isolated deployment.");
}

await verifyDestination();
const setup = await verifySeed();
const results = [];
try {
  const connection = await prepareWhop();
  for (let round = 1; round <= rounds; round += 1) {
    for (const writer of writers) {
      try {
        results.push({ round, race: `store / ${writer}`, outcome: await manualWriterRace(setup, connection, round, writer) });
      } catch (error) {
        results.push({ round, race: `store / ${writer}`, outcome: "failed" });
        throw error;
      }
    }
    await correctionRaces(setup, connection, round, results);
  }
} catch (error) {
  console.error(errorText(error));
  process.exitCode = 1;
} finally {
  console.table(results);
  try {
    await cleanup(setup.tenantId);
    console.log(`Cleaned the disposable fixture on ${name}.`);
  } catch (error) {
    console.error(`Cleanup failed on ${name}. Check the runbook before deleting any data.`, errorText(error));
    process.exitCode = 1;
  }
}
