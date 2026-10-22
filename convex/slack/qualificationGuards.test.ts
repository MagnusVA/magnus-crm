import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { SLACK_JOIN_LOOKBACK_MS, SLACK_OPPORTUNITY_EXPIRY_MS } from "../pipeline/slackJoinLookup";
import {
  guardHarness,
  guardStates,
  insertGuardDeal,
  todaysGuards as today,
  type GuardHarness,
  type GuardState,
} from "../../tests/dealGuardFixtures";

// Slack's rules read the same deals as before PR 7: a pending duplicate is a
// Qualified Slack deal from the last 30 days, an existing booking is an open
// deal that isn't an old Qualified one, and the expiry closes Qualified Slack
// deals (docs/plans/phase-5-deal-status.md §6.8, §6.10).

afterEach(() => vi.useRealTimers());

const DAY_MS = 24 * 60 * 60 * 1000;
// After the expiry's cutover, as in staleExpiry.test.ts.
const NOW = Date.parse("2026-11-20T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

const states: GuardState[] = [...guardStates("slack_qualified"), ...guardStates("calendly")];

async function slackInstallation(ctx: MutationCtx, tenantId: Id<"tenants">) {
  return await ctx.db.insert("slackInstallations", {
    tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
    botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
    notifyChannelName: "qualified", installedByWorkosUserId: "user_slack",
    installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
  });
}

/** A Slack-qualified person's deal at `state`, created `ageDays` ago, with their Instagram handle. */
async function personDeal(harness: GuardHarness, state: GuardState, ageDays: number, handle = "guard.person") {
  return await harness.t.run(async (ctx) => {
    const createdAt = NOW - ageDays * DAY_MS;
    const opportunityId = await insertGuardDeal(ctx, harness.tenantId, state, {
      createdAt,
      updatedAt: createdAt,
      latestActivityAt: createdAt,
      qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: createdAt },
    });
    const deal = (await ctx.db.get("opportunities", opportunityId))!;
    await ctx.db.patch("leads", deal.leadId, { fullName: "Guard Person" });
    await ctx.db.insert("leadIdentifiers", {
      tenantId: harness.tenantId,
      leadId: deal.leadId,
      type: "instagram",
      value: handle,
      rawValue: handle,
      source: "slack_qualified",
      confidence: "inferred",
      createdAt,
    });
    return { opportunityId, leadId: deal.leadId, createdAt };
  });
}

describe("a new Slack qualification for a person with a deal", () => {
  const cases = states.flatMap((state) =>
    [1, 31].map((ageDays) => ({ ...state, ageDays, label: `${state.label} (${state.source}), ${ageDays} days old` })),
  );

  it.each(cases)("$label", async (state) => {
    const harness = await guardHarness();
    const { opportunityId, createdAt } = await personDeal(harness, state, state.ageDays);
    const installationId = await harness.t.run((ctx) => slackInstallation(ctx, harness.tenantId));

    const result = await harness.t.mutation(internal.slack.createQualifiedLead.create, {
      tenantId: harness.tenantId,
      installationId,
      fullName: "Guard Person",
      handle: "@guard.person",
      country: "Mexico",
      leadType: "pt",
      qualifiedBy: { slackUserId: "U2", slackTeamId: "T1", submittedAt: NOW },
    });

    const cutoff = NOW - SLACK_JOIN_LOOKBACK_MS;
    const expected =
      today.slackQualifiedPending(state.status, state.source) && createdAt > cutoff
        ? "duplicate_pending"
        : today.blocksNewQualification(state.status, createdAt, cutoff)
          ? today.qualifiedPending(state.status)
            ? "duplicate_pending"
            : "existing_opportunity_bump"
          : "created";
    expect(result.kind).toBe(expected);
    if (expected !== "created") {
      expect(result).toMatchObject({ existingOpportunityId: opportunityId });
    }
  });
});

describe("the Slack expiry", () => {
  it("closes the Qualified Slack deals, and marks a person unresponsive only with no other open deal", async () => {
    const harness = await guardHarness();
    const deals = [];
    for (const [index, state] of states.entries()) {
      // Each person also has an old Qualified Slack deal the expiry closes.
      const handle = `guard.person.${index}`;
      const stale = await personDeal(
        harness,
        { label: "stale", status: "qualified_pending", source: "slack_qualified" },
        33,
        handle,
      );
      const other = await harness.t.run(async (ctx) => {
        const opportunityId = await insertGuardDeal(ctx, harness.tenantId, state, {
          createdAt: NOW - 33 * DAY_MS,
          qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: NOW - 33 * DAY_MS },
        });
        // On the same person as the stale deal.
        await ctx.db.patch("opportunities", opportunityId, { leadId: stale.leadId });
        return opportunityId;
      });
      deals.push({ state, stale, other });
    }

    await harness.t.mutation(internal.slack.staleExpiry.expireStaleSlackOpportunities, {});
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

    const result = await harness.t.run(async (ctx) => {
      const rows = [];
      for (const { state, stale, other } of deals) {
        rows.push({
          label: `${state.label} (${state.source})`,
          staleClosed: (await ctx.db.get("opportunities", stale.opportunityId))!.status,
          other: (await ctx.db.get("opportunities", other))!.status,
          disposition: (await ctx.db.get("leads", stale.leadId))!.disposition,
        });
      }
      return rows;
    });
    expect(result).toEqual(
      deals.map(({ state }) => ({
        label: `${state.label} (${state.source})`,
        staleClosed: "lost",
        other: today.slackQualifiedPending(state.status, state.source) ? "lost" : state.status,
        disposition:
          today.slackQualifiedPending(state.status, state.source) || !today.active(state.status)
            ? "unresponsive"
            : "open",
      })),
    );
  });

  it("previews and lists the Qualified Slack deals past the expiry", async () => {
    const harness = await guardHarness();
    const old = [];
    for (const [index, state] of states.entries()) {
      old.push({ state, ...(await personDeal(harness, state, 33, `guard.person.${index}`)) });
    }

    const preview = await harness.t.query(internal.slack.staleExpiry.previewStaleSlackOpportunities, {});
    const listed = await harness.t.query(internal.slack.staleRemindersData.listStaleOpportunities, {
      tenantId: harness.tenantId,
      cutoff: NOW - SLACK_OPPORTUNITY_EXPIRY_MS,
      limit: 100,
    });

    const expected = old
      .filter(({ state }) => today.slackQualifiedPending(state.status, state.source))
      .map(({ opportunityId }) => opportunityId);
    expect(preview.backlog + preview.cronWillClose).toBe(expected.length);
    expect(listed.opps.map((entry) => entry.opportunityId).sort()).toEqual([...expected].sort());
  });
});
