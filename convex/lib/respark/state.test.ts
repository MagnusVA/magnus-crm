import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { bookingHarness } from "../../../tests/bookingHarness";
import { SLACK_OPPORTUNITY_EXPIRY_MS } from "../../pipeline/slackJoinLookup";
import { STALE_EXPIRY_CUTOVER_AT } from "../../slack/staleExpiry";
import {
  backfillResparkStateFor,
  isLastTouchEvent,
  refreshResparkState,
  resparkGroupFor,
  resparkPool,
  resparkStateProblems,
} from "./state";
import type { ResparkGroup } from "./validators";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

const DAY_MS = 24 * 60 * 60 * 1000;
const QUALIFIED_AT = STALE_EXPIRY_CUTOVER_AT + 4 * DAY_MS;

async function slackInstallation(harness: Harness): Promise<Id<"slackInstallations">> {
  return await harness.t.run(async (ctx) =>
    await ctx.db.insert("slackInstallations", {
      tenantId: harness.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false,
      appId: "A1", botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack", installedAt: 0,
      tokenExpiresAt: 0, refreshToken: "r", status: "active",
    }),
  );
}

async function qualify(harness: Harness, handle: string, submittedAt: number) {
  vi.setSystemTime(new Date(submittedAt));
  const installationId = await slackInstallation(harness);
  await harness.t.mutation(internal.slack.createQualifiedLead.create, {
    tenantId: harness.tenantId,
    installationId,
    fullName: "Respark Lead",
    handle,
    country: "Honduras",
    leadType: "pt",
    qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt },
  });
}

async function capture(harness: Harness, handle: string, at: number) {
  vi.setSystemTime(new Date(at));
  await harness.admin.mutation(api.leadGen.capture.submit, {
    source: "instagram", rawHandleOrProfileUrl: `@${handle}`, originKind: "follower",
  });
}

async function expireSlackDeals(harness: Harness, at: number) {
  vi.setSystemTime(new Date(at));
  await harness.t.mutation(internal.slack.staleExpiry.expireStaleSlackOpportunities, {});
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function leads(harness: Harness): Promise<Doc<"leads">[]> {
  return await harness.t.run(async (ctx) => await ctx.db.query("leads").take(10));
}

async function poolCount(harness: Harness, group: ResparkGroup, tenantId = harness.tenantId) {
  return await harness.t.run((ctx) =>
    resparkPool.count(ctx, {
      namespace: tenantId,
      bounds: { prefix: [group] },
    }),
  );
}

async function problems(harness: Harness) {
  return await harness.t.run(async (ctx) => {
    const all = await ctx.db.query("leads").take(10);
    return (await Promise.all(all.map((lead) => resparkStateProblems(ctx, lead)))).flat();
  });
}

describe("isLastTouchEvent", () => {
  const base = { source: "closer" as const, metadataSource: undefined };
  it.each([
    ["lead.captured", true],
    ["lead.portal_note_added", true],
    ["meeting.created", true],
    ["meeting.no_show", true],
    ["meeting.canceled", true],
    ["payment.recorded", true],
    ["lead.resparked", true],
    ["lead.marked_not_a_fit", true],
    ["opportunity.stage_changed", true],
    ["opportunity.marked_lost", true],
    ["lead.lifecycle_stage_changed", false],
    ["lead.disposition_changed", false],
    ["lead.merged", false],
    ["payment.voided", false],
  ])("%s is a last touch: %s", (eventType, expected) => {
    expect(isLastTouchEvent({ ...base, eventType })).toBe(expected);
  });

  it("leaves out deal moves and losses the system made", () => {
    for (const eventType of ["opportunity.stage_changed", "opportunity.marked_lost"]) {
      expect(isLastTouchEvent({ ...base, eventType, source: "system" })).toBe(false);
      expect(isLastTouchEvent({ ...base, eventType, source: "pipeline" })).toBe(true);
    }
  });

  it("counts a meeting status change only to held", () => {
    const event = { ...base, eventType: "meeting.status_changed" };
    expect(isLastTouchEvent({ ...event, toStatus: "held" })).toBe(true);
    expect(isLastTouchEvent({ ...event, toStatus: "completed" })).toBe(true);
    expect(isLastTouchEvent({ ...event, toStatus: "scheduled" })).toBe(false);
  });

  it("counts a deal's creation only when it is a channel touch", () => {
    const event = { ...base, eventType: "opportunity.created" };
    expect(isLastTouchEvent({ ...event, metadataSource: "slack_qualified" })).toBe(true);
    expect(isLastTouchEvent({ ...event, metadataSource: "calendly" })).toBe(false);
  });
});

describe("resparkGroupFor", () => {
  const touch = { eventId: "e" as Id<"domainEvents">, eventType: "lead.captured", occurredAt: 1 };
  const person = (overrides: Partial<Doc<"leads">>) => ({
    status: "active" as const,
    lifecycleStage: "in_conversation" as const,
    disposition: "open" as const,
    lastTouch: touch,
    ...overrides,
  });

  it.each([
    [{ lifecycleStage: "prospect" as const }, false, "never_qualified"],
    [{ lifecycleStage: "in_conversation" as const }, false, "never_qualified"],
    [{ lifecycleStage: "qualified" as const }, false, "qualified"],
    [{ lifecycleStage: "booked" as const }, false, "had_call"],
    [{ lifecycleStage: "showed" as const }, false, "had_call"],
    [{ lifecycleStage: "customer" as const }, false, "out"],
    [{ lifecycleStage: "qualified" as const }, true, "out"],
    [{ disposition: "not_a_fit" as const, lifecycleStage: "booked" as const }, false, "not_a_fit"],
    [{ disposition: "not_a_fit" as const }, true, "out"],
    [{ disposition: "do_not_contact" as const }, false, "out"],
    [{ disposition: "unresponsive" as const }, false, "never_qualified"],
    [{ disposition: "nurture" as const }, false, "never_qualified"],
    [{ status: "merged" as const }, false, "out"],
    [{ lastTouch: undefined }, false, "out"],
  ])("%o with an open deal %s is %s", (overrides, openDeal, group) => {
    expect(resparkGroupFor(person(overrides), openDeal)).toBe(group);
  });
});

describe("refreshResparkState from live writes", () => {
  it("follows a Slack deal from open to expired, and the expiry is no touch", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    await qualify(harness, "respark.one", QUALIFIED_AT);

    const [qualified] = await leads(harness);
    expect(qualified.resparkGroup).toBe("out");
    expect(qualified.lastTouch?.occurredAt).toBe(QUALIFIED_AT);
    expect(await poolCount(harness, "out")).toBe(1);

    await expireSlackDeals(harness, QUALIFIED_AT + SLACK_OPPORTUNITY_EXPIRY_MS + DAY_MS);
    const [expired] = await leads(harness);
    expect(expired).toMatchObject({ resparkGroup: "qualified", disposition: "unresponsive" });
    expect(expired.lastTouch).toEqual(qualified.lastTouch);
    expect(await poolCount(harness, "out")).toBe(0);
    expect(await poolCount(harness, "qualified")).toBe(1);
    expect(await problems(harness)).toEqual([]);
  });

  it("puts a captured person in never_qualified, and a disposition moves them", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    const capturedAt = Date.parse("2026-09-15T08:00:00Z");
    await capture(harness, "respark.two", capturedAt);
    const [person] = await leads(harness);
    expect(person).toMatchObject({ resparkGroup: "never_qualified" });
    expect(person.lastTouch).toMatchObject({ eventType: "lead.captured", occurredAt: capturedAt });

    vi.setSystemTime(new Date(capturedAt + DAY_MS));
    await harness.admin.mutation(api.leads.lifecycleAdmin.setDisposition, {
      leadId: person._id, disposition: "not_a_fit", reason: "Test",
    });
    const [notAFit] = await leads(harness);
    expect(notAFit.resparkGroup).toBe("not_a_fit");
    // A disposition change isn't a touch.
    expect(notAFit.lastTouch).toEqual(person.lastTouch);

    await harness.admin.mutation(api.leads.lifecycleAdmin.setDisposition, {
      leadId: person._id, disposition: "do_not_contact", reason: "Test",
    });
    expect((await leads(harness))[0].resparkGroup).toBe("out");
    expect(await poolCount(harness, "out")).toBe(1);
    expect(await poolCount(harness, "not_a_fit")).toBe(0);
    expect(await problems(harness)).toEqual([]);
  });

  it("a merge takes the later last touch and drops the merged person's entry", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    const earlier = Date.parse("2026-09-01T08:00:00Z");
    const later = Date.parse("2026-09-20T08:00:00Z");
    await capture(harness, "respark.target", earlier);
    await capture(harness, "respark.source", later);
    const all = await leads(harness);
    const target = all.find((lead) => lead.lastTouch?.occurredAt === earlier)!;
    const source = all.find((lead) => lead.lastTouch?.occurredAt === later)!;
    expect(await poolCount(harness, "never_qualified")).toBe(2);

    vi.setSystemTime(new Date(later + DAY_MS));
    await harness.admin.mutation(api.leads.merge.mergeLead, {
      sourceLeadId: source._id, targetLeadId: target._id,
    });
    const merged = await harness.t.run(async (ctx) => ({
      target: (await ctx.db.get("leads", target._id))!,
      source: (await ctx.db.get("leads", source._id))!,
    }));
    expect(merged.target.lastTouch).toEqual(source.lastTouch);
    expect(merged.source.status).toBe("merged");
    expect(merged.source.resparkGroup).toBeUndefined();
    expect(await poolCount(harness, "never_qualified")).toBe(1);
    expect(await problems(harness)).toEqual([]);
  });

  it("stays inside the tenant it was called for", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    await capture(harness, "respark.tenant", Date.parse("2026-09-15T08:00:00Z"));
    const [person] = await leads(harness);
    const otherTenantId = await harness.t.run(async (ctx) =>
      await ctx.db.insert("tenants", {
        businessDayAppliedVersion: 0, companyName: "Other", contactEmail: "o@example.com",
        workosOrgId: "org_other", status: "active", inviteExpiresAt: 0, createdBy: "test",
      }),
    );
    await harness.t.run(async (ctx) => {
      await ctx.db.patch("leads", person._id, { disposition: "do_not_contact" });
      await refreshResparkState(ctx, otherTenantId, person._id);
    });
    expect((await leads(harness))[0].resparkGroup).toBe("never_qualified");
    expect(await poolCount(harness, "never_qualified", otherTenantId)).toBe(0);
    expect(await poolCount(harness, "out", otherTenantId)).toBe(0);
  });
});

describe("backfill and assert", () => {
  it("rebuilds cleared state from the records, idempotently, and the assert names a drift", async () => {
    vi.useFakeTimers();
    const harness = await bookingHarness();
    await qualify(harness, "respark.backfill", QUALIFIED_AT);
    await expireSlackDeals(harness, QUALIFIED_AT + SLACK_OPPORTUNITY_EXPIRY_MS + DAY_MS);
    const [live] = await leads(harness);

    // As before the deploy: no fields and no entry.
    await harness.t.run(async (ctx) => {
      await resparkPool.clear(ctx, { namespace: harness.tenantId });
      await ctx.db.patch("leads", live._id, { lastTouch: undefined, resparkGroup: undefined });
    });
    expect(await problems(harness)).toEqual([`lastTouch none, expected ${live.lastTouch!.eventId}`, "resparkGroup none, expected qualified"]);

    for (let run = 0; run < 2; run += 1) {
      await harness.t.run(async (ctx) => {
        await backfillResparkStateFor(ctx, (await ctx.db.get("leads", live._id))!);
      });
    }
    const [rebuilt] = await leads(harness);
    expect(rebuilt).toMatchObject({ lastTouch: live.lastTouch, resparkGroup: "qualified" });
    expect(await poolCount(harness, "qualified")).toBe(1);
    expect(await problems(harness)).toEqual([]);

    await harness.t.run((ctx) => resparkPool.clear(ctx, { namespace: harness.tenantId }));
    expect(await problems(harness)).toEqual([`missing pool entry [qualified, ${live.lastTouch!.occurredAt}]`]);
  });
});
