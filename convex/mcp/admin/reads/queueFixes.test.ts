import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import { adminCaller, adminFixture } from "../../../../tests/mcpAdminFixtures";
import { insertDeal } from "../../../../tests/dealStageFixtures";
import { insertCloserMeeting } from "../../../../tests/closerPipelineFixtures";

const reads = internal.mcp.admin.reads;
const HOUR = 3_600_000,
  DAY = 24 * HOUR;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T18:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function fixture() {
  const f = await adminFixture({ writeFamilies: ["results", "repairs"] });
  return { ...f, caller: adminCaller(f.orgId), now: Date.now() };
}

describe("not_recorded queue paging", () => {
  it("continues with the cursor after time moves on", async () => {
    const f = await fixture();
    const ids = await f.t.run(async (ctx) => {
      const out: Id<"meetings">[] = [];
      for (let i = 0; i < 3; i++) {
        const dealId = await insertDeal(ctx, {
          tenantId: f.tenantId,
          status: "scheduled",
          fields: { assignedCloserId: f.closerId },
        });
        out.push(
          await insertCloserMeeting(ctx, {
            tenantId: f.tenantId,
            opportunityId: dealId,
            closerId: f.closerId,
            status: "scheduled",
            scheduledAt: f.now - (5 - i) * HOUR,
          }),
        );
      }
      return out;
    });
    const first = await f.t.query(reads.queue.run, {
      caller: f.caller,
      queue: "not_recorded",
      limit: 1,
    });
    expect(first.items.map((r) => r.id)).toEqual([ids[0]]);
    expect(first.cursor).not.toBeNull();
    // A later call used to bound the index by a new Date.now() and Convex
    // refused the old cursor as InvalidCursor.
    vi.setSystemTime(f.now + 90_000);
    const second = await f.t.query(reads.queue.run, {
      caller: f.caller,
      queue: "not_recorded",
      limit: 1,
      cursor: first.cursor!,
    });
    expect(second.items.map((r) => r.id)).toEqual([ids[1]]);
    const third = await f.t.query(reads.queue.run, {
      caller: f.caller,
      queue: "not_recorded",
      limit: 1,
      cursor: second.cursor!,
    });
    expect(third.items.map((r) => r.id)).toEqual([ids[2]]);
  });

  it("keeps the first page's cutoff on later pages", async () => {
    const f = await fixture();
    const ids = await f.t.run(async (ctx) => {
      const meeting = async (scheduledAt: number) => {
        const dealId = await insertDeal(ctx, {
          tenantId: f.tenantId,
          status: "scheduled",
          fields: { assignedCloserId: f.closerId },
        });
        return await insertCloserMeeting(ctx, {
          tenantId: f.tenantId,
          opportunityId: dealId,
          closerId: f.closerId,
          status: "scheduled",
          scheduledAt,
        });
      };
      return {
        due: [await meeting(f.now - 3 * HOUR), await meeting(f.now - 2 * HOUR)],
        // Still running when the first page is read: 30 minutes long.
        running: await meeting(f.now - 10 * 60_000),
      };
    });
    const first = await f.t.query(reads.queue.run, {
      caller: f.caller,
      queue: "not_recorded",
      limit: 1,
    });
    expect(first.items.map((r) => r.id)).toEqual([ids.due[0]]);
    // An hour later the running meeting is due too, but the list the agent
    // is paging through is the one it started: a fixed index range, which
    // is also what lets Convex accept the cursor.
    vi.setSystemTime(f.now + HOUR);
    const rest = await f.t.query(reads.queue.run, {
      caller: f.caller,
      queue: "not_recorded",
      limit: 10,
      cursor: first.cursor!,
    });
    expect(rest.items.map((r) => r.id)).toEqual([ids.due[1]]);
    expect(rest.cursor).toBeNull();
  });

  it("refuses a cursor from another queue or filter, and junk", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        const dealId = await insertDeal(ctx, {
          tenantId: f.tenantId,
          status: "scheduled",
          fields: { assignedCloserId: f.closerId },
        });
        await insertCloserMeeting(ctx, {
          tenantId: f.tenantId,
          opportunityId: dealId,
          closerId: f.closerId,
          status: "scheduled",
          scheduledAt: f.now - (3 - i) * HOUR,
        });
      }
    });
    const first = await f.t.query(reads.queue.run, {
      caller: f.caller,
      queue: "not_recorded",
      limit: 1,
    });
    for (const args of [
      { queue: "payments_to_review" as const, cursor: first.cursor! },
      { queue: "not_recorded" as const, cursor: first.cursor!, closerId: f.closerId },
      { queue: "not_recorded" as const, cursor: "garbage" },
    ])
      await expect(
        f.t.query(reads.queue.run, { caller: f.caller, limit: 1, ...args }),
      ).rejects.toThrow("mcp.invalid_cursor");
  });
});

describe("missed_meetings queue", () => {
  it("keeps the web list's window and leaves out people who booked again", async () => {
    const f = await fixture();
    const ids = await f.t.run(async (ctx) => {
      const lost = (at: number, createdAt = at - DAY) =>
        insertDeal(ctx, {
          tenantId: f.tenantId,
          status: "no_show",
          fields: {
            assignedCloserId: f.closerId,
            lostReason: "no_show",
            lostAt: at,
            latestActivityAt: at,
            createdAt,
          },
        });
      const recent = await lost(f.now - 2 * DAY);
      const old = await lost(f.now - 60 * DAY);
      const rebooked = await lost(f.now - 3 * DAY);
      const deal = (await ctx.db.get("opportunities", rebooked))!;
      const again = await insertDeal(ctx, {
        tenantId: f.tenantId,
        status: "scheduled",
        fields: { createdAt: f.now - DAY },
      });
      await ctx.db.patch("opportunities", again, { leadId: deal.leadId });
      return { recent, old, rebooked };
    });
    const queue = await f.t.query(reads.queue.run, {
      caller: f.caller,
      queue: "missed_meetings",
    });
    expect(queue.items.map((r) => r.id)).toEqual([ids.recent]);
    for (const itemId of [ids.old, ids.rebooked])
      await expect(
        f.t.query(reads.queue.run, {
          caller: f.caller,
          queue: "missed_meetings",
          itemId,
        }),
      ).rejects.toThrow("can't find");
    const summary = await f.t.query(reads.brief.run, { caller: f.caller });
    const missed = summary.queues.find((q) => q.queue === "missed_meetings")!;
    expect(missed).toMatchObject({ count: 1, atLeast: 1, isPartial: false });
  });
});

describe("queue pages and summaries", () => {
  it("fills a failed-work page from a later source", async () => {
    const f = await fixture();
    const deliveryId = await f.t.run(async (ctx) => {
      const rawId = await ctx.db.insert("rawWebhookEvents", {
        tenantId: f.tenantId,
        calendlyEventUri: "uri",
        eventType: "invitee.created",
        payload: "{}",
        processed: false,
        receivedAt: f.now,
      });
      return await ctx.db.insert("webhookDeliveries", {
        tenantId: f.tenantId,
        key: "key",
        eventType: "invitee.created",
        inviteeUri: "uri",
        rawEventId: rawId,
        occurredAt: f.now,
        receivedAt: f.now,
        status: "blocked",
        generation: 1,
      });
    });
    const page = await f.t.query(reads.queue.run, {
      caller: f.caller,
      queue: "failed_work",
    });
    expect(page.items.map((r) => r.id)).toEqual([deliveryId]);
    expect(page.cursor).toBeNull();
  });

  it("answers a wrong-table closerId with a readable error", async () => {
    const f = await fixture();
    await expect(
      f.t.query(reads.queue.run, {
        caller: f.caller,
        queue: "not_recorded",
        closerId: f.tenantId,
      }),
    ).rejects.toThrow("mcp.invalid_argument");
  });

  it("refuses a page size the answer can't hold", async () => {
    const f = await fixture();
    await expect(
      f.t.query(reads.queue.run, {
        caller: f.caller,
        queue: "payments_to_review",
        limit: 25,
      }),
    ).rejects.toThrow("1 to 10");
  });

  it("counts the not-recorded backlog and lists every queue in the brief", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      const dealId = await insertDeal(ctx, {
        tenantId: f.tenantId,
        status: "scheduled",
        fields: { assignedCloserId: f.closerId },
      });
      await insertCloserMeeting(ctx, {
        tenantId: f.tenantId,
        opportunityId: dealId,
        closerId: f.closerId,
        status: "scheduled",
        scheduledAt: f.now - 2 * HOUR,
      });
    });
    const brief = await f.t.query(reads.brief.run, { caller: f.caller });
    expect(brief.queues.map((q) => q.queue)).toEqual(
      expect.arrayContaining(["unmatched_recordings", "team_review"]),
    );
    expect(brief.queues.find((q) => q.queue === "not_recorded")).toMatchObject({
      count: 1,
      atLeast: 1,
    });
    await expect(
      f.t.query(reads.brief.run, { caller: f.caller, date: "2026-02-30" }),
    ).rejects.toThrow("mcp.invalid_date");
  });
});
