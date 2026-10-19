/**
 * One timeline per person, from the event log, and a Slack touch for every
 * qualification (docs/plans/phase-2-person-first.md §6.1, §10.4).
 */
import migrationsTest from "@convex-dev/migrations/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { bookingHarness } from "../../tests/bookingHarness";
import { migrations } from "../migrations";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof setup>>;

const NOW = Date.parse("2026-10-10T12:00:00Z");

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const harness = await bookingHarness();
  migrationsTest.register(harness.t);
  const installationId = await harness.t.run(async (ctx) =>
    await ctx.db.insert("slackInstallations", {
      tenantId: harness.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false,
      appId: "A1", botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack", installedAt: 0,
      tokenExpiresAt: 0, refreshToken: "r", status: "active",
    }),
  );
  return { ...harness, installationId };
}

async function qualify(h: Harness, handle: string, submittedAt: number) {
  await h.t.mutation(internal.slack.createQualifiedLead.create, {
    tenantId: h.tenantId,
    installationId: h.installationId,
    fullName: "Ana Lead",
    handle,
    country: "Honduras",
    leadType: "pt",
    qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt },
  });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function timeline(h: Harness, leadId: string) {
  const result = await h.admin.query(api.leadCustomers.timeline.getLeadTimeline, {
    leadId: leadId as never,
  });
  return result!.entries;
}

describe("person timeline", () => {
  it("shows the capture, the qualification and the stage change, newest first, with who acted", async () => {
    const h = await setup();
    const { leadId } = await h.admin.mutation(api.leadGen.capture.submit, {
      source: "instagram", rawHandleOrProfileUrl: "@ana.lead", originKind: "follower",
    });
    vi.setSystemTime(new Date(NOW + 60_000));
    await qualify(h, "ana.lead", NOW + 60_000);

    const entries = await timeline(h, leadId!);

    const types = entries.map((entry) => entry.eventType);
    expect(types).toContain("lead.captured");
    expect(types).toContain("lead.slack_qualified");
    expect(types).toContain("lead.lifecycle_stage_changed");
    expect(entries.map((entry) => entry.occurredAt)).toEqual(
      [...entries.map((entry) => entry.occurredAt)].sort((a, b) => b - a),
    );
    const capture = entries.find((entry) => entry.eventType === "lead.captured");
    expect(capture).toMatchObject({ label: "Captured by lead gen", detail: "instagram · follower" });
    expect(capture?.actorName).toBe("admin@example.com");
    const stage = entries.find((entry) => entry.eventType === "lead.lifecycle_stage_changed");
    expect(stage).toMatchObject({ fromStatus: "Prospect", toStatus: "Qualified" });
  });

  it("includes the events of a lead merged into the person", async () => {
    const h = await setup();
    await qualify(h, "ana.lead", NOW - 1_000);
    await qualify(h, "ana.other", NOW - 500);
    const [target, source] = await h.t.run(async (ctx) => {
      const leads = await ctx.db.query("leads").take(2);
      return leads.map((lead) => lead._id);
    });

    await h.admin.mutation(api.leads.merge.mergeLead, { sourceLeadId: source, targetLeadId: target });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);

    const touches = (await timeline(h, target)).filter((entry) => entry.eventType === "lead.slack_qualified");
    expect(touches).toHaveLength(2);
  });
});

async function run(h: Harness, name: string, reset = false) {
  await h.t.mutation(internal.migrations.run, { fn: `migrations:${name}`, reset });
  await h.t.finishAllScheduledFunctions(vi.runAllTimers);
  const [status] = await h.t.run((ctx) =>
    migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
  );
  return status;
}

describe("Slack touches", () => {
  it("records a touch for every qualification, including one that joins an open deal", async () => {
    const h = await setup();
    await qualify(h, "ana.lead", NOW - 1_000);
    await qualify(h, "ana.lead", NOW - 500);

    const touches = await h.t.run(async (ctx) =>
      (await ctx.db.query("domainEvents").take(100)).filter((event) => event.eventType === "lead.slack_qualified"),
    );
    expect(touches).toHaveLength(2);
    expect((await run(h, "assertSlackTouches")).state).toBe("success");
  });

  it("backfills the touches of earlier qualifications once", async () => {
    const h = await setup();
    await qualify(h, "ana.lead", NOW - 1_000);
    await h.t.run(async (ctx) => {
      for (const event of await ctx.db.query("domainEvents").take(100)) {
        if (event.eventType === "lead.slack_qualified") await ctx.db.delete("domainEvents", event._id);
      }
    });

    expect((await run(h, "assertSlackTouches")).state).toBe("failed");
    expect((await run(h, "backfillSlackTouches")).state).toBe("success");
    expect((await run(h, "backfillSlackTouches", true)).state).toBe("success");
    expect((await run(h, "assertSlackTouches", true)).state).toBe("success");
    expect((await run(h, "assertDomainEventLinks")).state).toBe("success");
  });
});
