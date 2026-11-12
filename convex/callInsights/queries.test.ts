import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  callInsightsHarness,
  decisionsAnswer,
  gatewayFetch,
} from "../../tests/callInsightsHarness";
import { queueRead } from "./trigger";

vi.mock("convex/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/server")>()),
  getServiceToken: vi.fn(async () => "test-token"),
}));
vi.mock("../auth", () => ({ authKit: { registerRoutes: () => {} } }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T18:00:00Z"));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const queries = api.callInsights.queries;

async function fixture(rejected = false) {
  const f = await callInsightsHarness({
    settings: { mode: "on", suggestions: "on" },
  });
  vi.stubGlobal(
    "fetch",
    gatewayFetch(
      rejected
        ? {
            decisions: (body) =>
              decisionsAnswer(body, {
                noul: "result" in body.questions ? 0.95 : 0.1,
              }),
          }
        : {},
    ).fetchImpl,
  );
  await f.t.run((ctx) =>
    queueRead(ctx, {
      recordingId: f.recordingId,
      trigger: "recording_matched",
    }),
  );
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  const state = await f.t.run((ctx) =>
    ctx.db.query("resultSuggestionStates").first(),
  );
  if (!state) throw new Error("Missing test suggestion");
  await f.t.run(async (ctx) => {
    await ctx.db.insert("users", {
      tenantId: f.tenantId,
      workosUserId: "user_gen",
      email: "gen@example.com",
      role: "lead_generator",
      isActive: true,
    });
    const tenantId = await ctx.db.insert("tenants", {
      companyName: "Other",
      contactEmail: "foreign@example.com",
      workosOrgId: "org_foreign",
      status: "active",
      inviteExpiresAt: 0,
      createdBy: "test",
    });
    await ctx.db.insert("users", {
      tenantId,
      workosUserId: "user_foreign",
      email: "foreign@example.com",
      role: "tenant_master",
      isActive: true,
    });
  });
  return {
    ...f,
    generator: f.t.withIdentity({ subject: "user_gen", org_id: "org_test" }),
    foreign: f.t.withIdentity({
      subject: "user_foreign",
      org_id: "org_foreign",
    }),
    state,
  };
}

describe("meeting and person access", () => {
  it.each([
    "owner",
    "admin",
    "closer",
    "other",
    "generator",
    "foreign",
  ] as const)(
    "checks %s before returning words or suggestions",
    async (role) => {
      const f = await fixture();
      const allowed = role === "owner" || role === "admin" || role === "closer";
      const client = f[role];
      const card = await client.query(queries.forMeeting, {
        meetingId: f.meetingId,
      });
      const person = await client.query(queries.forPerson, {
        leadId: f.leadId,
      });
      const suggestion = await client.query(queries.suggestionForMeeting, {
        meetingId: f.meetingId,
      });
      if (allowed) {
        expect(card?.state).toBe("read");
        expect(card?.items).toHaveLength(2);
        expect(person).toMatchObject({ callsMatched: 1, callsRead: 1 });
        expect(suggestion?.kind).toBe("paid");
      } else {
        expect(card).toBeNull();
        expect(person).toBeNull();
        expect(suggestion).toBeNull();
      }
      expect(card?.admin !== undefined).toBe(
        role === "owner" || role === "admin",
      );
      await client.mutation(queries.markSuggestionShown, {
        stateId: f.state._id,
      });
      const state = await f.t.run((ctx) =>
        ctx.db.get("resultSuggestionStates", f.state._id),
      );
      expect(state?.shownAt !== undefined).toBe(allowed);
    },
  );

  it("keeps insights in shadow while suggestions follow their own switch", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const tenant = await ctx.db.get("tenants", f.tenantId);
      await ctx.db.patch("tenants", f.tenantId, {
        callInsights: { ...tenant!.callInsights!, mode: "shadow" },
      });
    });
    expect(
      await f.closer.query(queries.forMeeting, { meetingId: f.meetingId }),
    ).toBeNull();
    expect(
      await f.closer.query(queries.forPerson, { leadId: f.leadId }),
    ).toBeNull();
    expect(
      await f.closer.query(queries.suggestionForMeeting, {
        meetingId: f.meetingId,
      }),
    ).not.toBeNull();
    expect(
      (await f.owner.query(queries.forMeeting, { meetingId: f.meetingId }))
        ?.state,
    ).toBe("read");
    await f.owner.mutation(api.callInsights.admin.updateSettings, {
      mode: "off",
    });
    expect(
      await f.owner.query(queries.forMeeting, { meetingId: f.meetingId }),
    ).toBeNull();
    expect(
      await f.closer.query(queries.suggestionForMeeting, {
        meetingId: f.meetingId,
      }),
    ).toBeNull();
  });

  it("uses the deal assignment when the meeting has an older closer", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch("opportunities", f.opportunityId, {
        assignedCloserId: f.otherId,
      }),
    );
    expect(
      await f.closer.query(queries.forMeeting, { meetingId: f.meetingId }),
    ).toBeNull();
    expect(
      (await f.other.query(queries.forMeeting, { meetingId: f.meetingId }))
        ?.state,
    ).toBe("read");
  });

  it.each(["moved", "other_prospect"] as const)(
    "hides a publication that is now %s",
    async (kind) => {
      const f = await fixture();
      await f.t.run((ctx) =>
        ctx.db.patch(
          "callRecordings",
          f.recordingId,
          kind === "moved"
            ? { meetingId: undefined, matchStatus: "unmatched" }
            : { inviteeEmails: ["stranger@example.com"] },
        ),
      );
      expect(
        await f.owner.query(queries.forMeeting, { meetingId: f.meetingId }),
      ).toMatchObject({ state: "none", items: [] });
      expect(
        await f.owner.query(queries.forPerson, { leadId: f.leadId }),
      ).toMatchObject({ callsMatched: 0, callsRead: 0, income: [] });
      expect(
        await f.owner.query(queries.suggestionForMeeting, {
          meetingId: f.meetingId,
        }),
      ).toBeNull();
    },
  );

  it("returns null quotes after purge, including admin rejected quotes", async () => {
    const f = await fixture();
    await f.t.mutation(internal.callInsights.maintenance.purgeRecording, {
      recordingId: f.recordingId,
    });
    await f.t.finishAllScheduledFunctions(vi.runAllTimers);
    const card = await f.owner.query(queries.forMeeting, {
      meetingId: f.meetingId,
    });
    expect(card?.quotesDeleted).toBe(true);
    expect(
      card?.items.every((item) => item.quote === null && item.statement === ""),
    ).toBe(true);
    expect(
      await f.owner.query(queries.suggestionForMeeting, {
        meetingId: f.meetingId,
      }),
    ).toBeNull();
    const g = await fixture(true);
    await g.t.mutation(internal.callInsights.maintenance.purgeRecording, {
      recordingId: g.recordingId,
    });
    await g.t.finishAllScheduledFunctions(vi.runAllTimers);
    const rejected = await g.owner.query(queries.forMeeting, {
      meetingId: g.meetingId,
    });
    expect(rejected?.admin?.rejected).toHaveLength(2);
    expect(
      rejected?.admin?.rejected.every(
        (item) => item.quote === null && item.statement === "",
      ),
    ).toBe(true);
  });

  it("shows rejected items only to administrators", async () => {
    const f = await fixture(true);
    const owner = await f.owner.query(queries.forMeeting, {
      meetingId: f.meetingId,
    });
    expect(owner?.items).toEqual([]);
    expect(owner?.admin?.rejected).toHaveLength(2);
    expect(
      (await f.closer.query(queries.forMeeting, { meetingId: f.meetingId }))
        ?.admin,
    ).toBeUndefined();
  });

  it("keeps the published reading while a newer one is queued", async () => {
    const f = await fixture();
    await f.owner.mutation(api.callInsights.admin.readAgain, {
      recordingId: f.recordingId,
    });
    expect(
      await f.owner.query(queries.forMeeting, { meetingId: f.meetingId }),
    ).toMatchObject({
      state: "read",
      generation: 1,
      items: [{ kind: "objection" }, { kind: "income" }],
    });
  });

  it("aggregates facts without returning statements and uses selfReportedIncome", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch("leads", f.leadId, { selfReportedIncome: 4500 }),
    );
    const person = await f.closer.query(queries.forPerson, {
      leadId: f.leadId,
    });
    expect(person).toMatchObject({
      dmReportedIncome: 4500,
      objections: [
        {
          category: "partner",
          calls: 1,
          lastResolution: "unresolved",
          wasPrimary: true,
        },
      ],
      income: [
        {
          kind: "personal_income",
          monthlyMinMinor: 600000,
          check: "confirmed",
        },
      ],
    });
    expect(JSON.stringify(person)).not.toContain("husband");
    await f.t.run(async (ctx) => {
      const facts = await ctx.db.query("callInsightFacts").take(10);
      for (const fact of facts)
        if (fact.kind !== "call")
          await ctx.db.patch("callInsightFacts", fact._id, { check: "unsure" });
    });
    expect(
      (await f.owner.query(queries.forPerson, { leadId: f.leadId }))?.income[0]
        .check,
    ).toBe("unsure");
  });
});

describe("suggestion presentation", () => {
  it("returns ready values, an amount hint, and the prefill switch independently", async () => {
    const f = await fixture();
    expect(
      await f.closer.query(queries.suggestionForMeeting, {
        meetingId: f.meetingId,
      }),
    ).toMatchObject({
      values: { amountMinor: 170000 },
      amountHintMinor: 170000,
      amountPrefill: false,
    });
    await f.owner.mutation(api.callInsights.admin.updateSettings, {
      amountPrefill: true,
    });
    expect(
      (
        await f.closer.query(queries.suggestionForMeeting, {
          meetingId: f.meetingId,
        })
      )?.amountPrefill,
    ).toBe(true);
    await f.t.run((ctx) =>
      ctx.db.patch("resultSuggestionStates", f.state._id, { tier: "check" }),
    );
    const check = await f.closer.query(queries.suggestionForMeeting, {
      meetingId: f.meetingId,
    });
    expect(check?.values).toEqual({});
    expect(check?.amountHintMinor).toBeUndefined();
  });

  it("stamps exposure once and never overwrites the first viewer", async () => {
    const f = await fixture();
    await f.closer.mutation(queries.markSuggestionShown, {
      stateId: f.state._id,
    });
    vi.setSystemTime(Date.now() + 60_000);
    await f.owner.mutation(queries.markSuggestionShown, {
      stateId: f.state._id,
    });
    const state = await f.t.run((ctx) =>
      ctx.db.get("resultSuggestionStates", f.state._id),
    );
    expect(state?.shownAt).toBe(Date.now() - 60_000);
    expect(state?.shownToUserId).toBe(f.closerId);
  });

  it("presents Certain as Review unless enabled and the slot is an hour past", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch("resultSuggestionStates", f.state._id, {
        kind: "no_show",
        noShowTier: "certain",
        waitedSeconds: 7 * 60,
      }),
    );
    expect(
      (
        await f.owner.query(queries.suggestionForMeeting, {
          meetingId: f.meetingId,
        })
      )?.noShowTier,
    ).toBe("review");
    const presented = async () =>
      (
        await f.owner.query(queries.suggestionForMeeting, {
          meetingId: f.meetingId,
        })
      )?.noShowTier;
    await f.owner.mutation(api.callInsights.admin.updateSettings, {
      noShowCertain: true,
      noShowWaitMinutes: 5,
    });
    expect(await presented()).toBe("certain");
    // The closer waited seven minutes: a longer required wait takes Certain back.
    await f.owner.mutation(api.callInsights.admin.updateSettings, {
      noShowWaitMinutes: 10,
    });
    expect(await presented()).toBe("review");
  });
});

describe("admin reads", () => {
  it.each([
    "owner",
    "admin",
    "closer",
    "other",
    "generator",
    "foreign",
  ] as const)("checks %s for every admin reader", async (role) => {
    const f = await fixture();
    const client = f[role];
    const admin = role === "owner" || role === "admin" || role === "foreign";
    expect((await client.query(queries.settings, {})) !== null).toBe(admin);
    const preview = await client.query(queries.backfillPreview, {
      scope: "unread",
    });
    expect(preview !== null).toBe(role === "owner" || role === "admin");
    const calls = await client.query(queries.calls, {
      paginationOpts: { cursor: null, numItems: 25 },
    });
    expect(calls.page.length).toBe(
      role === "owner" || role === "admin" ? 1 : 0,
    );
    const queue = await client.query(queries.suggestionQueue, {});
    expect(queue.queue.length).toBe(
      role === "owner" || role === "admin" ? 1 : 0,
    );
    expect((await client.query(queries.agreementSplit, {})) !== null).toBe(
      admin,
    );
  });

  it("shows the Second opinion share and current spend without changing its settings", async () => {
    const f = await fixture();
    expect(await f.owner.query(queries.settings, {})).toMatchObject({
      enabled: true,
      secondOpinion: { capUsd: 40, spentUsd: 0 },
      budget: {
        monthKey: "2026-11",
        capUsd: 60,
        secondOpinionShareUsd: 40,
        limitUsd: 20,
        reservedUsd: 0,
        evalSpentUsd: 0,
      },
    });
    expect(
      (await f.owner.query(queries.settings, {}))?.budget.spentUsd,
    ).toBeGreaterThan(0);
  });

  it("reports saved-result differences and splits Second opinion by exposure and use", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.patch("meetings", f.meetingId, {
        status: "held",
        heldMarkedAt: Date.now(),
      });
      await ctx.db.insert("secondOpinions", {
        tenantId: f.tenantId,
        meetingId: f.meetingId,
        recordingId: f.recordingId,
        closerUserId: f.closerId,
        trigger: "result_recorded",
        inputKey: "split-test",
        model: "test",
        status: "answered",
        attempts: 1,
        verdict: "agrees",
        createdAt: Date.now(),
      });
    });
    expect(
      (await f.owner.query(queries.suggestionQueue, {})).differs,
    ).toMatchObject([
      {
        suggestedKind: "paid",
        recordedKind: "held_other",
        comparison: "different_result",
      },
    ]);
    expect(
      (await f.owner.query(queries.agreementSplit, {}))?.noneShown,
    ).toMatchObject({ total: 1, agrees: 1 });
    await f.t.run((ctx) =>
      ctx.db.patch("resultSuggestionStates", f.state._id, {
        shownAt: Date.now(),
      }),
    );
    expect(
      (await f.owner.query(queries.agreementSplit, {}))?.shownNotUsed.total,
    ).toBe(1);
    await f.t.run((ctx) =>
      ctx.db.patch("resultSuggestionStates", f.state._id, {
        usedAt: Date.now(),
        changedFields: [],
      }),
    );
    expect((await f.owner.query(queries.agreementSplit, {}))?.used.total).toBe(
      1,
    );
    await f.t.run((ctx) =>
      ctx.db.patch("resultSuggestionStates", f.state._id, {
        changedFields: ["amountMinor"],
      }),
    );
    expect(
      (await f.owner.query(queries.agreementSplit, {}))?.usedEdited.total,
    ).toBe(1);
  });
});
