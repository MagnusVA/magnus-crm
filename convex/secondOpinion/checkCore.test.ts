import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { secondOpinionHarness } from "../../tests/secondOpinionHarness";
import { dumpTables, writtenRows } from "../../tests/writeDump";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { checkSecondOpinionCheckAllowed, secondOpinionCheckCore } from "../secondOpinion";

// `secondOpinion.check` split into a guard and a core (admin assistant,
// commit 9), and its new `second_opinion.checked` event (commit 6).

afterEach(() => vi.useRealTimers());

const MCP = { via: "mcp", agentClient: "claude-ai" } as const;
const NOW = Date.parse("2026-10-20T18:00:00Z");

async function openDisagreement() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const f = await secondOpinionHarness("on", "no_show");
  const id: Id<"secondOpinions"> = await f.t.run(async (ctx) => {
    await insertOpportunityAggregate(ctx, f.opportunityId);
    return await ctx.db.insert("secondOpinions", {
      tenantId: f.tenantId,
      meetingId: f.meetingId,
      recordingId: f.recordingId,
      closerUserId: f.closerId,
      trigger: "result_recorded",
      record: { kind: "no_show" },
      inputKey: "key",
      model: "typesafe/jev-1.13",
      status: "answered",
      attempts: 1,
      verdict: "disagrees",
      reviewState: "open",
      createdAt: NOW - 60_000,
      answeredAt: NOW - 30_000,
    });
  });
  const admin = { userId: f.adminId, tenantId: f.tenantId, role: "tenant_admin" as const };
  return { ...f, id, actor: admin };
}

type Fixture = Awaited<ReturnType<typeof openDisagreement>>;

async function writes(f: Fixture, write: () => Promise<unknown>) {
  const before = await dumpTables(f.t);
  const result = await write();
  const after = await dumpTables(f.t);
  return { result, written: writtenRows(before, after) };
}

/** The written rows less the new event, which the pre-split snapshot lacks. */
function withoutCheckedEvent(written: ReturnType<typeof writtenRows>) {
  const events = written.domainEvents;
  if (!events) return written;
  const added = events.added.filter((row) => row.eventType !== "second_opinion.checked");
  const rest = { ...written };
  if (added.length || events.changed.length || events.deleted.length) {
    rest.domainEvents = { ...events, added };
  } else {
    delete rest.domainEvents;
  }
  return rest;
}

async function checkedEvents(f: Fixture) {
  return await f.t.run(async (ctx) =>
    (await ctx.db.query("domainEvents").take(100))
      .filter((event) => event.eventType === "second_opinion.checked")
      .map((event) => ({
        entityType: event.entityType,
        entityId: event.entityId,
        source: event.source,
        actorUserId: event.actorUserId,
        metadata: JSON.parse(event.metadata ?? "{}") as Record<string, unknown>,
      })),
  );
}

const REOPEN = { date: "2026-10-22", time: "10:00" };

describe("the web check", () => {
  it("writes the review and a second_opinion.checked event", async () => {
    const f = await openDisagreement();
    const { written } = await writes(f, () =>
      f.admin.mutation(api.secondOpinion.check, { secondOpinionId: f.id, outcome: "closer_right" }),
    );
    expect(withoutCheckedEvent(written)).toMatchSnapshot();
    expect(await checkedEvents(f)).toEqual([
      {
        entityType: "meeting",
        entityId: f.meetingId,
        source: "admin",
        actorUserId: f.adminId,
        metadata: { secondOpinionId: f.id, outcome: "closer_right", reopened: false },
      },
    ]);
  });

  it("reopens a no-show at Follow-up and records it", async () => {
    const f = await openDisagreement();
    const { written } = await writes(f, () =>
      f.admin.mutation(api.secondOpinion.check, {
        secondOpinionId: f.id,
        outcome: "second_opinion_right",
        reopen: REOPEN,
      }),
    );
    expect(withoutCheckedEvent(written)).toMatchSnapshot();
    expect((await checkedEvents(f))[0].metadata).toEqual({
      secondOpinionId: f.id,
      outcome: "second_opinion_right",
      reopened: true,
    });
  });

  it("refuses a second check and a closer, with the same messages", async () => {
    const f = await openDisagreement();
    await expect(
      f.closer.mutation(api.secondOpinion.check, { secondOpinionId: f.id, outcome: "closer_right" }),
    ).rejects.toThrow();
    await f.admin.mutation(api.secondOpinion.check, { secondOpinionId: f.id, outcome: "closer_right" });
    await expect(
      f.admin.mutation(api.secondOpinion.check, { secondOpinionId: f.id, outcome: "closer_right" }),
    ).rejects.toThrow("This disagreement isn't open for review.");
  });
});

describe("secondOpinionCheckCore", () => {
  it("writes what the web writes and tags the event for an agent", async () => {
    const web = await openDisagreement();
    const webWrites = await writes(web, () =>
      web.admin.mutation(api.secondOpinion.check, {
        secondOpinionId: web.id,
        outcome: "second_opinion_right",
        reopen: REOPEN,
      }),
    );
    const mcp = await openDisagreement();
    const mcpWrites = await writes(mcp, () =>
      mcp.t.run((ctx) =>
        secondOpinionCheckCore(
          ctx,
          mcp.actor,
          { secondOpinionId: mcp.id, outcome: "second_opinion_right", reopen: REOPEN },
          MCP,
        ),
      ),
    );
    const untag = (written: typeof webWrites.written) =>
      JSON.parse(JSON.stringify(written).replaceAll(',"via":"mcp","agentClient":"claude-ai"', "")) as unknown;
    expect(untag(mcpWrites.written)).toEqual(webWrites.written);
    expect(JSON.stringify(mcpWrites.written)).toContain('"via":"mcp","agentClient":"claude-ai"');
    expect((await checkedEvents(mcp))[0].metadata).toEqual({
      secondOpinionId: mcp.id,
      outcome: "second_opinion_right",
      reopened: true,
      via: "mcp",
      agentClient: "claude-ai",
    });
  });

  it("checks without writing, and returns the refusal", async () => {
    const f = await openDisagreement();
    const before = await dumpTables(f.t);
    const allowed = await f.t.run((ctx) =>
      checkSecondOpinionCheckAllowed(ctx, f.actor, { secondOpinionId: f.id, outcome: "closer_right" }),
    );
    expect(allowed).toMatchObject({ ok: true, meetingId: f.meetingId });
    expect(writtenRows(before, await dumpTables(f.t))).toEqual({});
    await f.admin.mutation(api.secondOpinion.check, { secondOpinionId: f.id, outcome: "closer_right" });
    const refused = await f.t.run((ctx) =>
      checkSecondOpinionCheckAllowed(ctx, f.actor, { secondOpinionId: f.id, outcome: "closer_right" }),
    );
    expect(refused).toEqual({
      ok: false,
      code: "second_opinion.review_denied",
      message: "This disagreement isn't open for review.",
    });
  });
});
