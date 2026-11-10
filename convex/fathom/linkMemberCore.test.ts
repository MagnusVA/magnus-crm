import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { secondOpinionHarness } from "../../tests/secondOpinionHarness";
import { dumpTables, writtenRows } from "../../tests/writeDump";
import { checkLinkMemberAllowed, linkMemberCore } from "./connection";
import { attachRecordingCore } from "./recordings";

// `linkMember` split into a guard and a core (admin assistant, commit 9), and
// `attachRecordingCore` given a provenance. The web snapshots were taken on
// the handlers before the split.

afterEach(() => vi.useRealTimers());

const MCP = { via: "mcp", agentClient: "claude-ai" } as const;

async function memberHarness() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  const f = await secondOpinionHarness("off", "held");
  const memberId: Id<"fathomOrgMembers"> = await f.t.run((ctx) =>
    ctx.db.insert("fathomOrgMembers", {
      tenantId: f.tenantId,
      email: "kim@example.com",
      name: "Kim",
      ignored: false,
      lastSyncedAt: 0,
    }),
  );
  const actor = { userId: f.adminId, tenantId: f.tenantId, role: "tenant_admin" as const };
  return { ...f, memberId, actor };
}

type Harness = Awaited<ReturnType<typeof memberHarness>>;

async function writes(harness: Harness, write: () => Promise<unknown>) {
  const before = await dumpTables(harness.t);
  const result = await write();
  const after = await dumpTables(harness.t);
  return { result, written: writtenRows(before, after) };
}

describe("web paths write what they wrote before the split", () => {
  it("linkMember links, ignores, and refuses", async () => {
    const h = await memberHarness();
    expect(
      await writes(h, () =>
        h.admin.mutation(api.fathom.connection.linkMember, { memberId: h.memberId, userId: h.closerId }),
      ),
    ).toMatchSnapshot();
    expect(
      await writes(h, () =>
        h.admin.mutation(api.fathom.connection.linkMember, { memberId: h.memberId, ignored: true }),
      ),
    ).toMatchSnapshot();
    const inactive = await h.t.run((ctx) =>
      ctx.db.insert("users", {
        tenantId: h.tenantId,
        workosUserId: "user_gone",
        email: "gone@example.com",
        role: "closer",
        isActive: false,
      }),
    );
    await expect(
      h.admin.mutation(api.fathom.connection.linkMember, { memberId: h.memberId, userId: inactive }),
    ).rejects.toThrow("Choose an active member of this tenant.");
    await expect(
      h.closer.mutation(api.fathom.connection.linkMember, { memberId: h.memberId, userId: h.closerId }),
    ).rejects.toThrow();
  });

  it("attach, a manual match", async () => {
    const h = await memberHarness();
    await h.t.run((ctx) =>
      ctx.db.patch("callRecordings", h.recordingId, { meetingId: undefined, matchStatus: "unmatched" }),
    );
    expect(
      await writes(h, () =>
        h.admin.mutation(api.fathom.recordings.attach, { recordingId: h.recordingId, meetingId: h.meetingId }),
      ),
    ).toMatchSnapshot();
  });
});

describe("cores", () => {
  it("linkMemberCore writes what the web writes", async () => {
    const web = await memberHarness();
    const webWrites = await writes(web, () =>
      web.admin.mutation(api.fathom.connection.linkMember, { memberId: web.memberId, userId: web.closerId }),
    );
    const mcp = await memberHarness();
    const mcpWrites = await writes(mcp, () =>
      mcp.t.run((ctx) => linkMemberCore(ctx, mcp.actor, { memberId: mcp.memberId, userId: mcp.closerId }, MCP)),
    );
    expect(mcpWrites).toEqual(webWrites);
  });

  it("checkLinkMemberAllowed returns the refusal without writing", async () => {
    const h = await memberHarness();
    const before = await dumpTables(h.t);
    expect(
      await h.t.run((ctx) => checkLinkMemberAllowed(ctx, h.actor, { memberId: h.memberId, userId: h.closerId })),
    ).toMatchObject({ ok: true, memberId: h.memberId });
    expect(
      await h.t.run((ctx) =>
        checkLinkMemberAllowed(ctx, h.actor, { memberId: h.memberId, userId: h.otherId, ignored: false }),
      ),
    ).toMatchObject({ ok: true });
    await h.t.run((ctx) => ctx.db.patch("users", h.otherId, { isActive: false }));
    expect(
      await h.t.run((ctx) => checkLinkMemberAllowed(ctx, h.actor, { memberId: h.memberId, userId: h.otherId })),
    ).toEqual({
      ok: false,
      code: "fathom.invalid_user",
      message: "Choose an active member of this tenant.",
    });
    const after = await dumpTables(h.t);
    const written = writtenRows(before, after);
    expect(Object.keys(written)).toEqual(["users"]);
  });

  it("attachRecordingCore tags the match event for an agent", async () => {
    const h = await memberHarness();
    await h.t.run((ctx) =>
      ctx.db.patch("callRecordings", h.recordingId, { meetingId: undefined, matchStatus: "unmatched" }),
    );
    await h.t.run((ctx) =>
      attachRecordingCore(ctx, h.actor, { recordingId: h.recordingId, meetingId: h.meetingId }, MCP),
    );
    const metadata = await h.t.run(async (ctx) =>
      (await ctx.db.query("domainEvents").take(50))
        .filter((event) => event.eventType === "meeting.recording_matched")
        .map((event) => JSON.parse(event.metadata ?? "{}") as unknown),
    );
    expect(metadata).toEqual([{ recordingId: h.recordingId, via: "mcp", agentClient: "claude-ai" }]);
  });
});
