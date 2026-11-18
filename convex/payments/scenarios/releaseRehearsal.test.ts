import { afterEach, expect, it, vi } from "vitest";
import { assertAutomationInvariants } from "../../../tests/automationInvariants";
import { bookingHarness } from "../../../tests/bookingHarness";
import { insertTask } from "../../../tests/closerPipelineFixtures";
import { insertProgram } from "../../../tests/enrollmentFixtures";
import { assertPaymentInvariants } from "../../../tests/paymentInvariants";
import { storeProofFile } from "../../../tests/proofFixtures";
import {
  FIXTURE_NOW,
  FIXTURE_PAID_AT,
  PRODUCT_ID,
  VARIANT_ID,
  automationFixtureApi,
  insertPaymentFixtureConnection,
  insertProviderBinding,
  insertProviderDeal,
  insertProviderFact,
  insertProviderIdentifier,
  insertProviderMeeting,
  insertProviderPerson,
} from "../../../tests/providerPaymentFixtures";
import { api, internal } from "../../_generated/api";

const settings = automationFixtureApi.settings;
const before = FIXTURE_NOW + 86_400_000;

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function rehearsalFixture(pendingProviderWork: boolean) {
  vi.setSystemTime(FIXTURE_NOW - 4_000);
  const f = await bookingHarness({ transactionLimits: true });
  const { t, tenantId } = f;

  if (pendingProviderWork) {
    // A separate tenant already has a pending Phase 1 payment when this
    // tenant starts using the new schema. Neither tenant has automation settings.
    vi.setSystemTime(FIXTURE_NOW - 2_000);
    await t.run(async (ctx) => {
      const otherTenantId = await ctx.db.insert("tenants", {
        businessDayAppliedVersion: 0, companyName: "Pasture Test",
        contactEmail: "pasture@example.com", workosOrgId: "org_pasture_synthetic",
        status: "active", inviteExpiresAt: 0, createdBy: "test",
      });
      const otherAdminId = await ctx.db.insert("users", {
        tenantId: otherTenantId, workosUserId: "user_pasture_admin", email: "pasture@example.com",
        role: "tenant_admin", isActive: true,
      });
      const connectionId = await insertPaymentFixtureConnection(ctx, otherTenantId, otherAdminId);
      await insertProviderFact(ctx, otherTenantId, connectionId, {
        externalPaymentId: "pay_pending_phase_one", payerEmail: "ask@example.com", reviewState: "needs_person",
      });
    });
  }

  vi.setSystemTime(FIXTURE_NOW);
  const ids = await t.run(async (ctx) => {
    await ctx.db.patch("tenants", tenantId, { billingOpsEnabled: true });
    const users = await ctx.db.query("users").withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId)).take(3);
    const adminId = users.find((user) => user.role === "tenant_admin")!._id;
    const closerId = users.find((user) => user.role === "closer")!._id;
    const ownerId = await ctx.db.insert("users", {
      tenantId, workosUserId: "user_owner", email: "owner@example.com", role: "tenant_master", isActive: true,
    });
    const programId = await insertProgram(ctx, tenantId, "Sales training");

    async function person(label: string) {
      const email = `${label}@example.com`;
      const leadId = await insertProviderPerson(ctx, tenantId, { email, fullName: `Rehearsal ${label}` });
      await insertProviderIdentifier(ctx, tenantId, leadId, "email", email);
      return { leadId, email };
    }
    async function booked(label: string, minutesAgo: number) {
      const { leadId, email } = await person(label);
      const opportunityId = await insertProviderDeal(ctx, { tenantId, leadId, assignedCloserId: closerId });
      const meetingId = await insertProviderMeeting(ctx, {
        tenantId, opportunityId, closerId, scheduledAt: FIXTURE_NOW - minutesAgo * 60_000,
      });
      return { opportunityId, meetingId, email };
    }
    const meeting = await booked("meeting", 45);
    const shadow = await booked("shadow", 40);
    const ask = await booked("ask", 35);
    const reminder = await insertProviderDeal(ctx, {
      tenantId, leadId: (await person("reminder")).leadId, assignedCloserId: closerId, position: "follow_up",
    });
    const followUpId = await insertTask(ctx, {
      opportunityId: reminder, type: "manual_reminder", reason: "closer_initiated",
      status: "pending", reminderScheduledAt: FIXTURE_NOW - 60_000,
    });
    const sideDealId = await insertProviderDeal(ctx, {
      tenantId, leadId: (await person("side")).leadId, assignedCloserId: closerId, source: "side_deal",
    });
    return { meeting, shadow, ask, followUpId, sideDealId, adminId, ownerId, programId };
  });
  const owner = t.withIdentity({ subject: "user_owner", org_id: "org_test" });
  return { ...f, ...ids, owner };
}

type Fixture = Awaited<ReturnType<typeof rehearsalFixture>>;

function today(f: Fixture) {
  return f.closer.query(api.closer.dashboard.getMeetingsNeedingOutcome, { before });
}

async function snapshot(f: Fixture) {
  const { t, tenantId } = f;
  // Include the entire application rows. Identity-only rows supply the mapping
  // for generated IDs embedded in references or in event metadata.
  const { rows, references } = await t.run(async (ctx) => ({
    rows: {
      opportunities: (await ctx.db.query("opportunities").take(12)).filter((row) => row.tenantId === tenantId),
      meetings: (await ctx.db.query("meetings").take(12)).filter((row) => row.tenantId === tenantId),
      followUps: (await ctx.db.query("followUps").take(12)).filter((row) => row.tenantId === tenantId),
      payments: (await ctx.db.query("paymentRecords").take(12)).filter((row) => row.tenantId === tenantId),
      leads: (await ctx.db.query("leads").take(12)).filter((row) => row.tenantId === tenantId),
      enrollments: (await ctx.db.query("enrollments").take(12)).filter((row) => row.tenantId === tenantId),
      search: (await ctx.db.query("leadCustomerSearchRows").take(12)).filter((row) => row.tenantId === tenantId),
      events: (await ctx.db.query("domainEvents").take(80)).filter((row) => row.tenantId === tenantId),
      suggestions: (await ctx.db.query("secondOpinions").take(12)).filter((row) => row.tenantId === tenantId),
    },
    references: {
      tenant: [{ _id: tenantId }],
      users: (await ctx.db.query("users").take(8)).filter((row) => row.tenantId === tenantId),
      programs: (await ctx.db.query("tenantPrograms").take(8)).filter((row) => row.tenantId === tenantId),
      corrections: (await ctx.db.query("paymentCorrections").take(8)).filter((row) => row.tenantId === tenantId),
      files: await ctx.db.system.query("_storage").take(8),
    },
  }));
  const liveEnrollments = new Set<string>(rows.enrollments.map(({ _id }) => _id));
  const removedEnrollments = rows.events
    .filter(({ eventType, entityId }) => eventType === "enrollment.removed" && !liveEnrollments.has(entityId))
    .map(({ entityId }) => ({ _id: entityId }));
  const ids = Object.entries({ ...rows, ...references, removedEnrollments }).flatMap(([table, entries]) =>
    entries.map(({ _id }, index) => [_id, `[${table}/${index + 1}]`] as const),
  );
  const json = JSON.stringify({ rows, today: await today(f) }, (key, value: unknown) => {
    if (key === "humanResultRevision" || key === "completionPaymentId") return undefined;
    if (typeof value !== "string") return value;
    for (const [id, alias] of ids) value = (value as string).replaceAll(id, alias);
    return value;
  });
  return JSON.parse(json) as { rows: typeof rows; today: Awaited<ReturnType<typeof today>> };
}

function proof(f: Fixture, name: string) {
  return storeProofFile(f.t, { contents: `synthetic rehearsal proof ${name}` });
}

function meetingArgs(f: Fixture, which: "meeting" | "shadow" | "ask") {
  const { opportunityId, meetingId } = f[which];
  return { opportunityId, meetingId, programId: f.programId, amount: 100, currency: "USD", paymentType: "pif" as const };
}

type Step = <Result>(name: string, action: () => Promise<Result>) => Promise<Result>;

async function legacyRound(f: Fixture, step: Step) {
  await step("read Today with old booked meetings and pending reminder", async () => {
    expect((await today(f)).meetings).toHaveLength(3);
    expect((await f.owner.query(settings.getSettings, {})).configured).toBeNull();
  });
  const first = await step("the closer logs a manual meeting payment", async () =>
    f.closer.mutation(api.closer.payments.logPayment, { ...meetingArgs(f, "meeting"), proofFileId: await proof(f, "meeting") }),
  );
  await step("the closer logs a manual reminder payment", async () =>
    f.closer.mutation(api.closer.reminderOutcomes.logReminderPayment, {
      followUpId: f.followUpId, amount: 200, currency: "USD", programId: f.programId,
      paymentType: "pif", proofFileId: await proof(f, "reminder"),
    }),
  );
  const { paymentId: sidePayment } = await step("the closer logs a manual side-deal payment", async () =>
    f.closer.mutation(api.sideDeals.logPayment.logPayment, {
      opportunityId: f.sideDealId, amount: 300, currency: "USD", programId: f.programId,
      paymentType: "pif", proofFileId: await proof(f, "side deal"),
    }),
  );
  await step("the closer logs a manual additional payment", async () =>
    f.closer.mutation(api.closer.additionalPayment.recordAdditionalPayment, {
      opportunityId: f.meeting.opportunityId, amount: 50, currency: "USD",
      paymentType: "split", proofFileId: await proof(f, "additional"),
    }),
  );
  await step("an admin voids the side-deal payment", () =>
    f.admin.mutation(api.sideDeals.voidPayment.voidPayment, { paymentId: sidePayment, reason: "Test transcription error" }),
  );
  await step("Billing corrects the original meeting payment and the additional payment keeps the deal won", async () => {
    const target = { paymentRecordId: first, cause: "voided" as const };
    const preview = await f.admin.query(api.payments.exclude.previewExclusion, target);
    expect(preview.survivors).toHaveLength(1);
    const result = await f.admin.mutation(api.payments.exclude.excludePayment, {
      ...target, level: "reviewed", expectedFingerprint: preview.fingerprint,
    });
    expect(result).toMatchObject({ ok: true, alreadyApplied: false });
  });
  await step("Today still shows the other two calls awaiting a result", async () => {
    const result = await today(f);
    expect(result.meetings.map(({ rowKind, meetingId }) => [rowKind, meetingId])).toEqual([
      ["outcome", f.ask.meetingId],
      ["outcome", f.shadow.meetingId],
    ]);
  });
}

it("rehearses the manual release, shadow, ask, pause and resume", async () => {
  vi.useFakeTimers();
  const baseline = await rehearsalFixture(false);
  const expected = new Map<string, Awaited<ReturnType<typeof snapshot>>>();

  function runSteps(f: Fixture, compare: boolean) {
    let clock = FIXTURE_NOW;
    return async function step<Result>(name: string, action: () => Promise<Result>) {
      vi.setSystemTime(clock += 60_000);
      try {
        const result = await action();
        await assertPaymentInvariants(f.t, { tenantId: f.tenantId });
        const actual = await snapshot(f);
        if (compare) expect(actual).toEqual(expected.get(name));
        else expected.set(name, actual);
        return result;
      } catch (error) {
        throw new Error(`Step: ${name} (${compare ? "release with pending data" : "empty provider tables"})`, { cause: error });
      }
    };
  }

  await legacyRound(baseline, runSteps(baseline, false));
  vi.clearAllTimers();
  const f = await rehearsalFixture(true);
  await legacyRound(f, runSteps(f, true));

  const { t, tenantId, closer, owner, admin, programId, adminId } = f;
  const decisions = () => t.run((ctx) => ctx.db.query("resultAutomationDecisions")
    .withIndex("by_tenantId_and_inputKey", (q) => q.eq("tenantId", tenantId)).take(15));
  const askTarget = { target: { kind: "meeting", meetingId: f.ask.meetingId } } as const;
  const writer = async () => closer.mutation(api.closer.payments.logPayment, {
    ...meetingArgs(f, "ask"), proofFileId: await proof(f, "ask"),
  });
  const reconciliation = () => closer.query(api.payments.reconcileCheck.getPaymentReconciliation, askTarget);
  const askRow = () => closer.query(api.payments.confirm.getWhopAsk, askTarget);
  const setMode = (mode: "shadow" | "ask") => owner.mutation(settings.setKindMode, { kind: "payment_win", mode });

  async function step<Result>(name: string, action: () => Result | Promise<Result>) {
    vi.setSystemTime(Date.now() + 60_000);
    try {
      const result = await action();
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await assertPaymentInvariants(t, { tenantId });
      await assertAutomationInvariants(t, { tenantId });
      return result;
    } catch (error) {
      throw new Error(`Step: ${name}`, { cause: error });
    }
  }

  const connection = await step("connect a sandbox fixture with result automation still off", () => t.run(async (ctx) => {
    const connectionId = await insertPaymentFixtureConnection(ctx, tenantId, adminId);
    await insertProviderBinding(ctx, {
      tenantId, connectionId, adminId, externalId: PRODUCT_ID, binding: { kind: "product_program", programId },
    });
    await insertProviderBinding(ctx, {
      tenantId, connectionId, adminId, externalId: VARIANT_ID, binding: { kind: "variant_type", paymentType: "pif" },
    });
    return (await ctx.db.get("tenantPaymentConnections", connectionId))!;
  }));

  async function storeWhopPayment(label: "ask" | "shadow") {
    const externalPaymentId = `pay_rehearsal_${label}`;
    const identity = {
      connectionId: connection._id, accountId: connection.accountId, connectedAt: connection.connectedAt, externalPaymentId,
    };
    const generation = await t.mutation(internal.payments.intake.beginPaymentRead, identity);
    if (generation === null) throw new Error("Whop read could not start");
    expect(await t.mutation(internal.payments.intake.storePaymentRead, {
      ...identity, generation,
      payment: {
        externalPaymentId, status: "paid", sourceCreatedAt: FIXTURE_PAID_AT,
        sourceUpdatedAt: Date.now(), paidAt: FIXTURE_PAID_AT, totalMinor: 10_000,
        currency: "USD", decimals: 2, refundedMinor: 0, adverseState: "none",
        billingReason: "one_time", lineItemCount: 1, failedAttemptCount: 0,
        payerEmail: f[label].email, productId: PRODUCT_ID, variantId: VARIANT_ID,
      },
    })).toBe("stored");
  }

  await step("receive a mapped Whop payment while automation is off", () => storeWhopPayment("ask"));
  expect(await decisions()).toEqual([]);
  expect(await reconciliation()).toMatchObject({ conflicts: [] });
  const beforeShadow = await today(f);

  await step("the owner switches payment wins to shadow", async () => {
    await owner.mutation(settings.setEnabled, { enabled: true });
    await setMode("shadow");
  });
  await step("shadow writes decisions and keeps Today and the payment form unchanged", async () => {
    expect(await decisions()).toMatchObject([{ kind: "payment_win", mode: "shadow", state: "shadow", wouldWrite: true }]);
    expect(await today(f)).toEqual(beforeShadow);
    expect(await askRow()).toBeNull();
    expect(await reconciliation()).toMatchObject({ conflicts: [] });
  });

  await step("a real manual writer still saves an eligible sale in shadow without a prompt", async () => {
    await storeWhopPayment("shadow");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const paymentId = await closer.mutation(api.closer.payments.logPayment, {
      ...meetingArgs(f, "shadow"), proofFileId: await proof(f, "shadow"),
    });
    expect(await t.run((ctx) => ctx.db.get("paymentRecords", paymentId)))
      .toMatchObject({ origin: "closer_meeting", amountMinor: 10_000 });
  });
  const beforeAsk = await today(f);
  await step("the owner raises payment wins to ask", () => setMode("ask"));
  const visibleAsk = await step("Today shows the ask for the outstanding meeting", async () => {
    const proposal = await askRow();
    expect(proposal).not.toBeNull();
    expect((await today(f)).meetings).toMatchObject([{ rowKind: "whop_ask", decisionId: proposal!.decisionId }]);
    return proposal!;
  });
  const beforeBlindSave = await snapshot(f);
  await step("the writer asks which payment it is and leaves the rows alone", async () => {
    await expect(writer()).rejects.toMatchObject({
      data: {
        code: "payment.whop_payment_found",
        conflicts: [expect.objectContaining({ providerPaymentId: visibleAsk.providerPaymentId, state: "unlinked" })],
      },
    });
    expect((await snapshot(f)).rows).toEqual(beforeBlindSave.rows);
  });

  const manualRows = async () => {
    const { events, ...rows } = (await snapshot(f)).rows;
    return { ...rows, events: events.filter(({ eventType }) => eventType !== "automation.settings_changed") };
  };
  const beforePause = await manualRows();
  await step("an admin switches automation off", () => admin.mutation(settings.setEnabled, { enabled: false }));
  const stopped = await step("the ready decision stops and Today goes back to the manual row", async () => {
    const rows = await decisions();
    expect(rows.find(({ _id }) => _id === visibleAsk.decisionId)).toMatchObject({ state: "stopped", stopCode: "paused" });
    expect(await today(f)).toEqual(beforeAsk);
    expect(await askRow()).toBeNull();
    expect(await reconciliation()).toMatchObject({ conflicts: [] });
    expect(await manualRows()).toEqual(beforePause);
    return rows;
  });

  await step("the owner switches automation on again", () => owner.mutation(settings.setEnabled, { enabled: true }));
  await step("the old decisions stay stopped even after a sweep", async () => {
    expect(await decisions()).toEqual(stopped);
    await t.mutation(automationFixtureApi.sweep.run, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await decisions();
    expect(rows.filter((row) => row.state === "ready")).toEqual([]);
    expect(rows.find(({ _id }) => _id === visibleAsk.decisionId)).toEqual(stopped.find(({ _id }) => _id === visibleAsk.decisionId));
    expect(await askRow()).toBeNull();
    expect(await today(f)).toEqual(beforeAsk);
    expect(await manualRows()).toEqual(beforePause);
  });
});
