import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  callInsightsHarness,
  gatewayFetch,
} from "../../tests/callInsightsHarness";
import { storeProofFile } from "../../tests/proofFixtures";
import { dumpTables, writtenRows } from "../../tests/writeDump";
import { queueRead } from "./trigger";
import {
  insertMeetingAggregate,
  insertOpportunityAggregate,
} from "../reporting/writeHooks";
import type { FromSuggestion } from "./validators";
import * as suggestionState from "./suggest/state";

vi.mock("convex/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/server")>()),
  getServiceToken: vi.fn(async () => "test-token"),
}));
vi.mock("../auth", () => ({ authKit: { registerRoutes: () => {} } }));

const NOW = Date.parse("2026-11-03T18:00:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup() {
  vi.setSystemTime(NOW);
  const f = await callInsightsHarness({ settings: { suggestions: "on" } });
  vi.stubGlobal("fetch", vi.fn(gatewayFetch().fetchImpl));
  await f.t.run((ctx) =>
    queueRead(ctx, {
      recordingId: f.recordingId,
      trigger: "recording_matched",
    }),
  );
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
  const row = await f.t.run((ctx) =>
    ctx.db
      .query("resultSuggestionStates")
      .withIndex("by_meetingId", (q) => q.eq("meetingId", f.meetingId))
      .first(),
  );
  if (!row) throw new Error("Missing published suggestion");
  const { programId, otherMeetingId, otherTenantId } = await f.t.run(
    async (ctx) => {
      await insertMeetingAggregate(ctx, f.meetingId);
      await insertOpportunityAggregate(ctx, f.opportunityId);
      await ctx.db.patch("resultSuggestionStates", row._id, {
        shownAt: Date.now(),
        shownToUserId: f.closerId,
      });
      await ctx.db.patch("users", f.closerId, {
        personalEventTypeUri: "https://calendly.com/kim/sales",
      });
      const meeting = await ctx.db.get("meetings", f.meetingId);
      if (!meeting) throw new Error("Missing meeting");
      const { _id, _creationTime, ...fields } = meeting;
      void _id;
      void _creationTime;
      const otherMeetingId = await ctx.db.insert("meetings", {
        ...fields,
        status: "canceled",
        calendlyEventUri: "other-event",
      });
      await insertMeetingAggregate(ctx, otherMeetingId);
      const programId = await ctx.db.insert("tenantPrograms", {
        tenantId: f.tenantId,
        name: "Scale Program",
        normalizedName: "scale program",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdByUserId: f.ownerId,
      });
      const otherTenantId = await ctx.db.insert("tenants", {
        companyName: "Other",
        contactEmail: "other@example.com",
        workosOrgId: "org_other",
        status: "active",
        inviteExpiresAt: 0,
        createdBy: "test",
      });
      return { programId, otherMeetingId, otherTenantId };
    },
  );
  const proofFileId = await storeProofFile(f.t, {
    contents: "suggestion-save-receipt",
  });
  return {
    ...f,
    programId,
    otherMeetingId,
    otherTenantId,
    proofFileId,
    ref: {
      stateId: row._id,
      revision: row.revision,
      changedFields: ["amount"],
    } satisfies FromSuggestion,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const suggestion = (f: Fixture) =>
  f.t.run((ctx) => ctx.db.get("resultSuggestionStates", f.ref.stateId));
const paymentArgs = (f: Fixture) => ({
  opportunityId: f.opportunityId,
  meetingId: f.meetingId,
  amount: 1800,
  currency: "USD",
  programId: f.programId,
  paymentType: "pif" as const,
});

type Save = {
  name: string;
  admin?: boolean;
  withoutMeeting?: boolean;
  save: (
    f: Fixture,
    ref?: FromSuggestion,
    noMeeting?: boolean,
  ) => Promise<unknown>;
};
const saves: Save[] = [
  {
    name: "logPayment",
    save: (f, fromSuggestion) =>
      f.closer.mutation(api.closer.payments.logPayment, {
        ...paymentArgs(f),
        proofFileId: f.proofFileId,
        fromSuggestion,
      }),
  },
  {
    name: "markAsLost",
    withoutMeeting: true,
    save: (f, fromSuggestion, noMeeting) =>
      f.closer.mutation(api.closer.meetingActions.markAsLost, {
        opportunityId: f.opportunityId,
        meetingId: noMeeting ? undefined : f.meetingId,
        reason: "Price",
        fromSuggestion,
      }),
  },
  {
    name: "createManualReminderFollowUpPublic",
    withoutMeeting: true,
    save: (f, fromSuggestion, noMeeting) =>
      f.closer.mutation(
        api.closer.followUpMutations.createManualReminderFollowUpPublic,
        {
          opportunityId: f.opportunityId,
          meetingId: noMeeting ? undefined : f.meetingId,
          contactMethod: "call",
          reminderScheduledAt: Date.now() + 86_400_000,
          fromSuggestion,
        },
      ),
  },
  {
    name: "createSchedulingLinkFollowUp",
    withoutMeeting: true,
    save: (f, fromSuggestion, noMeeting) =>
      f.closer.mutation(
        api.closer.followUpMutations.createSchedulingLinkFollowUp,
        {
          opportunityId: f.opportunityId,
          meetingId: noMeeting ? undefined : f.meetingId,
          fromSuggestion,
        },
      ),
  },
  {
    name: "markNoShow",
    save: (f, fromSuggestion) =>
      f.closer.mutation(api.closer.noShowActions.markNoShow, {
        meetingId: f.meetingId,
        reason: "no_response",
        fromSuggestion,
      }),
  },
  {
    name: "adminMarkAsLost",
    admin: true,
    withoutMeeting: true,
    save: (f, fromSuggestion, noMeeting) =>
      f.admin.mutation(api.admin.meetingActions.adminMarkAsLost, {
        opportunityId: f.opportunityId,
        meetingId: noMeeting ? undefined : f.meetingId,
        reason: "Price",
        fromSuggestion,
      }),
  },
  {
    name: "adminCreateFollowUp",
    admin: true,
    withoutMeeting: true,
    save: (f, fromSuggestion, noMeeting) =>
      f.admin.mutation(api.admin.meetingActions.adminCreateFollowUp, {
        opportunityId: f.opportunityId,
        meetingId: noMeeting ? undefined : f.meetingId,
        fromSuggestion,
      }),
  },
  {
    name: "adminCreateManualReminder",
    admin: true,
    withoutMeeting: true,
    save: (f, fromSuggestion, noMeeting) =>
      f.admin.mutation(api.admin.meetingActions.adminCreateManualReminder, {
        opportunityId: f.opportunityId,
        meetingId: noMeeting ? undefined : f.meetingId,
        contactMethod: "text",
        reminderScheduledAt: Date.now() + 86_400_000,
        fromSuggestion,
      }),
  },
  {
    name: "adminMarkNoShow",
    admin: true,
    save: (f, fromSuggestion) =>
      f.admin.mutation(api.admin.meetingActions.adminMarkNoShow, {
        meetingId: f.meetingId,
        reason: "technical_issues",
        fromSuggestion,
      }),
  },
];

const refKinds = [
  "valid",
  "other_meeting",
  "other_tenant",
  "stale",
  "hidden",
  "absent",
] as const;
type RefKind = (typeof refKinds)[number];
async function reference(f: Fixture, kind: RefKind) {
  if (kind === "absent") return undefined;
  if (kind === "stale") return { ...f.ref, revision: f.ref.revision + 1 };
  await f.t.run(async (ctx) => {
    if (kind === "other_meeting") {
      await ctx.db.patch("resultSuggestionStates", f.ref.stateId, {
        meetingId: f.otherMeetingId,
      });
    }
    if (kind === "other_tenant") {
      await ctx.db.patch("resultSuggestionStates", f.ref.stateId, {
        tenantId: f.otherTenantId,
      });
    }
    if (kind === "hidden") {
      const tenant = await ctx.db.get("tenants", f.tenantId);
      if (!tenant?.callInsights) throw new Error("Missing settings");
      await ctx.db.patch("tenants", f.tenantId, {
        callInsights: { ...tenant.callInsights, suggestions: "hidden" },
      });
    }
  });
  return f.ref;
}

async function saveWrites(f: Fixture, save: Save, ref?: FromSuggestion) {
  const before = await dumpTables(f.t);
  await save.save(f, ref);
  const writes = writtenRows(before, await dumpTables(f.t));
  delete writes.resultSuggestionStates;
  return writes;
}

describe.each(saves)("$name suggestion references", (save) => {
  it.each(refKinds)(
    "preserves the save's business writes with a %s ref",
    async (kind) => {
      const baseline = await setup();
      const expected = await saveWrites(baseline, save);
      vi.clearAllTimers();
      const f = await setup();
      const ref = await reference(f, kind);
      const before = await suggestion(f);
      expect(await saveWrites(f, save, ref)).toEqual(expected);
      const after = await suggestion(f);
      if (kind === "valid") {
        expect(after).toMatchObject({
          usedAt: expect.any(Number),
          usedByUserId: save.admin ? f.adminId : f.closerId,
          changedFields: ["amount"],
        });
        if (save.name === "logPayment") {
          expect(after?.paymentId).toBeDefined();
          expect(after?.proofWaived).toBeUndefined();
        }
      } else expect(after).toEqual(before);
    },
  );
});

it.each(saves.filter((save) => save.withoutMeeting))(
  "$name ignores the ref when no meeting was given",
  async (save) => {
    const f = await setup();
    const before = await suggestion(f);
    await save.save(f, f.ref, true);
    expect(await suggestion(f)).toEqual(before);
  },
);

describe("meeting payment proof", () => {
  it.each(["paid", "promised"] as const)(
    "waives proof for a shown %s suggestion even when the amount was edited",
    async (kind) => {
      const f = await setup();
      await f.t.run((ctx) =>
        ctx.db.patch("resultSuggestionStates", f.ref.stateId, { kind }),
      );
      const paymentId = await f.closer.mutation(
        api.closer.payments.logPayment,
        { ...paymentArgs(f), fromSuggestion: f.ref },
      );
      expect(await suggestion(f)).toMatchObject({
        paymentId,
        proofWaived: true,
        usedByUserId: f.closerId,
        changedFields: ["amount"],
      });
      expect(
        await f.t.run((ctx) => ctx.db.get("paymentRecords", paymentId)),
      ).toMatchObject({ amountMinor: 180_000, status: "recorded" });
    },
  );

  it.each([
    "absent",
    "stale",
    "non_payment",
    "never_shown",
    "not_confirmed",
    "disputed",
    "hidden",
    "other_meeting",
    "other_tenant",
  ] as const)("still requires the closer's proof for %s", async (kind) => {
    const f = await setup();
    const own =
      kind === "non_payment" ||
      kind === "never_shown" ||
      kind === "not_confirmed" ||
      kind === "disputed";
    const ref = own ? f.ref : await reference(f, kind);
    // A suggestion Jev couldn't confirm or disputes offers no "Log payment" button.
    if (kind === "not_confirmed")
      await f.t.run((ctx) =>
        ctx.db.patch("resultSuggestionStates", f.ref.stateId, {
          tier: "unconfirmed",
        }),
      );
    if (kind === "disputed")
      await f.t.run((ctx) =>
        ctx.db.patch("resultSuggestionStates", f.ref.stateId, {
          tier: "check",
        }),
      );
    if (kind === "non_payment")
      await f.t.run((ctx) =>
        ctx.db.patch("resultSuggestionStates", f.ref.stateId, { kind: "lost" }),
      );
    if (kind === "never_shown")
      await f.t.run((ctx) =>
        ctx.db.patch("resultSuggestionStates", f.ref.stateId, {
          shownAt: undefined,
        }),
      );
    const before = await dumpTables(f.t);
    await expect(
      f.closer.mutation(api.closer.payments.logPayment, {
        ...paymentArgs(f),
        fromSuggestion: ref,
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "payment.proof_required" }),
    });
    expect(writtenRows(before, await dumpTables(f.t))).toEqual({});
  });

  it.each(["absent", "stale", "valid"] as const)(
    "keeps admin proof optional for %s",
    async (kind) => {
      const f = await setup();
      const ref = await reference(f, kind);
      const paymentId = await f.admin.mutation(api.closer.payments.logPayment, {
        ...paymentArgs(f),
        fromSuggestion: ref,
      });
      expect(
        await f.t.run((ctx) => ctx.db.get("paymentRecords", paymentId)),
      ).toMatchObject({ status: "recorded", recordedByUserId: f.adminId });
      // Admins never needed proof, so nothing was waived for them.
      if (kind === "valid") {
        const used = await suggestion(f);
        expect(used?.paymentId).toBe(paymentId);
        expect(used?.proofWaived).toBeUndefined();
      } else expect((await suggestion(f))?.usedAt).toBeUndefined();
    },
  );

  it("validates a given proof file even with a valid suggestion", async () => {
    const f = await setup();
    const proofFileId: Id<"_storage"> = await storeProofFile(f.t, {
      contentType: "text/plain",
    });
    const before = await dumpTables(f.t);
    await expect(
      f.closer.mutation(api.closer.payments.logPayment, {
        ...paymentArgs(f),
        proofFileId,
        fromSuggestion: f.ref,
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "payment.proof_type" }),
    });
    expect(writtenRows(before, await dumpTables(f.t))).toEqual({});
  });
});

describe.each(saves)("$name tolerates suggestion failures", (save) => {
  it.each(["resolveSuggestionRef", "markSuggestionUsed"] as const)(
    "still saves when %s fails",
    async (helper) => {
      const baseline = await setup();
      const expected = await saveWrites(baseline, save);
      vi.clearAllTimers();
      const f = await setup();
      vi.spyOn(suggestionState, helper).mockRejectedValueOnce(
        new Error("Suggestion tracking failed"),
      );
      expect(await saveWrites(f, save, f.ref)).toEqual(expected);
      expect((await suggestion(f))?.usedAt).toBeUndefined();
    },
  );
});
