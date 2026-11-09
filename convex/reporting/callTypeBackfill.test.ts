/**
 * The call-type backfill (convex/reporting/callTypeBackfill.ts): a meeting is
 * a first call until a held call on its deal comes before it. The deal here
 * goes through the real booking pipeline: a first call moved in Calendly, a
 * no-show, a rebook through the no-show link that's held, then a follow-up
 * booked after that held call. Its stored types are then set the way the old
 * rule ("any earlier meeting") and an unbackfilled v0.5 row left them.
 */
import { afterEach, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { patchMeetingLifecycle } from "../lib/meetingLifecycle";
import { meetingsByStatus } from "./aggregates";
import {
  crmLinkTracking,
  inviteeUri,
  minutesFromNow,
  missedMeetingHarness,
  type MissedMeetingHarness,
} from "../../tests/missedMeetingFixtures";

afterEach(() => vi.useRealTimers());

type Stored = "new" | "follow_up" | undefined;

/** Books, moves, misses, rebooks and holds calls on one deal; returns its meetings. */
async function dealWithEveryKindOfCall(h: MissedMeetingHarness) {
  const { opportunityId, meetingId: original } = await h.book(
    { key: "original", start: "2026-10-06T15:00:00Z" },
    "2026-10-02T10:00:00Z",
  );
  // Calendly moves the first call to Oct 7.
  await h.deliver(
    "invitee.canceled",
    { key: "original", start: "2026-10-06T15:00:00Z", canceled: { rescheduledTo: inviteeUri("moved") } },
    "2026-10-03T09:00:00Z",
  );
  await h.deliver(
    "invitee.created",
    { key: "moved", start: "2026-10-07T15:00:00Z", oldInvitee: inviteeUri("original") },
    "2026-10-03T09:00:03Z",
  );
  const moved = (await h.meeting("moved"))!._id;
  // The person misses it, and books again through the no-show link.
  await h.deliver("invitee_no_show.created", { key: "moved", start: "2026-10-07T15:00:00Z" }, "2026-10-07T16:00:00Z");
  h.clockAt("2026-10-07T17:00:00Z");
  await h.closerActions.rescheduleLink(opportunityId, moved);
  const { meetingId: rebook } = await h.book(
    {
      key: "rebook",
      start: "2026-10-09T15:00:00Z",
      tracking: crmLinkTracking("noshow_resched", opportunityId, moved),
    },
    minutesFromNow(60),
  );
  // The rebooked call is held; the closer sends a scheduling link from it.
  h.clockAt("2026-10-09T15:40:00Z");
  const linkId = await h.closerActions.schedulingLink(opportunityId, rebook);
  const { meetingId: later } = await h.book(
    {
      key: "later",
      start: "2026-10-13T15:00:00Z",
      tracking: crmLinkTracking("follow_up", opportunityId, linkId),
    },
    minutesFromNow(60),
  );
  return { opportunityId, original, moved, rebook, later };
}

/** Sets stored types through the lifecycle helper, so the aggregate follows. */
async function setStoredTypes(h: MissedMeetingHarness, types: Record<string, Stored>) {
  await h.t.run(async (ctx) => {
    for (const [id, type] of Object.entries(types)) {
      await patchMeetingLifecycle(ctx, id as Id<"meetings">, { callClassification: type });
    }
  });
}

async function storedTypes(h: MissedMeetingHarness, ids: Record<string, Id<"meetings">>) {
  return await h.t.run(async (ctx) => {
    const out: Record<string, Stored> = {};
    for (const [name, id] of Object.entries(ids)) out[name] = (await ctx.db.get("meetings", id))?.callClassification;
    return out;
  });
}

async function ledger(h: MissedMeetingHarness) {
  return await h.t.run((ctx) => ctx.db.query("callTypeBackfillChanges").take(50));
}

/** Meetings the aggregate counts for the closer under `type` and `status`. */
async function aggregateCount(h: MissedMeetingHarness, closerId: Id<"users">, type: "new" | "follow_up", status: "held") {
  return await h.t.run((ctx) =>
    meetingsByStatus.count(ctx, { namespace: h.tenantId, bounds: { prefix: [closerId, type, status] } }),
  );
}

/** What the old rule and an unbackfilled row left behind. */
const OLD_TYPES = (m: Awaited<ReturnType<typeof dealWithEveryKindOfCall>>) => ({
  [m.original]: "new" as Stored,
  [m.moved]: "follow_up" as Stored,
  [m.rebook]: "follow_up" as Stored,
  [m.later]: undefined,
});

it("files moved first calls and rebooks as first calls, keeps follow-ups after a held call, and the reverse restores every old type", async () => {
  const h = await missedMeetingHarness();
  const m = await dealWithEveryKindOfCall(h);
  const ids = { original: m.original, moved: m.moved, rebook: m.rebook, later: m.later };
  expect(await h.meeting("rebook")).toMatchObject({ status: "held", rescheduledFromMeetingId: m.moved });
  const closerId = (await h.meeting("rebook"))!.assignedCloserId;
  await setStoredTypes(h, OLD_TYPES(m));
  expect(await aggregateCount(h, closerId, "follow_up", "held")).toBe(1);

  // The dry run reports the changes and writes nothing.
  const preview = await h.t.action(internal.reporting.callTypeBackfill.previewCallTypeBackfill, {});
  expect(preview).toMatchObject({ changes: 3, toFirst: 2, toFollowUp: 1 });
  expect(await ledger(h)).toEqual([]);
  expect((await h.runMigration("assertCallTypes"))?.error).toContain("is filed as");

  expect(await h.runMigration("backfillCallTypes")).toMatchObject({ isDone: true, state: "success" });
  expect(await storedTypes(h, ids)).toEqual({ original: "new", moved: "new", rebook: "new", later: "follow_up" });
  expect((await ledger(h)).map((row) => [row.meetingId, row.from, row.to]).sort()).toEqual(
    [
      [m.moved, "follow_up", "new"],
      [m.rebook, "follow_up", "new"],
      [m.later, "unset", "follow_up"],
    ].sort(),
  );
  // The aggregate moved the held rebook from follow-ups to first calls.
  expect(await aggregateCount(h, closerId, "follow_up", "held")).toBe(0);
  expect(await aggregateCount(h, closerId, "new", "held")).toBe(1);
  expect(await h.runMigration("assertCallTypes", { reset: true })).toMatchObject({ isDone: true, state: "success" });

  // A second run changes nothing.
  expect(await h.runMigration("backfillCallTypes", { reset: true })).toMatchObject({ isDone: true });
  expect(await ledger(h)).toHaveLength(3);

  // The reverse puts back what the ledger recorded, a missing type included.
  expect(await h.runMigration("reverseCallTypeBackfill")).toMatchObject({ isDone: true, state: "success" });
  expect(await storedTypes(h, ids)).toEqual({ original: "new", moved: "follow_up", rebook: "follow_up", later: undefined });
  expect((await ledger(h)).every((row) => row.revertedAt !== undefined && row.revertSkipped === undefined)).toBe(true);
  expect(await aggregateCount(h, closerId, "follow_up", "held")).toBe(1);
});

it("the reverse leaves a meeting whose type changed again after the backfill", async () => {
  const h = await missedMeetingHarness();
  const m = await dealWithEveryKindOfCall(h);
  await setStoredTypes(h, OLD_TYPES(m));
  await h.runMigration("backfillCallTypes");
  // Something else re-filed the rebook after the backfill.
  await setStoredTypes(h, { [m.rebook]: "follow_up" });

  await h.runMigration("reverseCallTypeBackfill");
  const rows = await ledger(h);
  expect(rows.find((row) => row.meetingId === m.rebook)).toMatchObject({ revertSkipped: "changed_since" });
  expect(await storedTypes(h, { moved: m.moved, rebook: m.rebook })).toEqual({ moved: "follow_up", rebook: "follow_up" });
});
