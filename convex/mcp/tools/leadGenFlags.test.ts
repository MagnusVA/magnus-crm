import type { FunctionReturnType } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  callTool,
  createMcpHarness,
  mcpConnect,
  seedTenantWithLeadGen,
} from "../../../tests/mcpHarness";

const failure = vi.hoisted(() => ({ voidFails: false }));
vi.mock("../../leadGen/aggregates", async (original) => {
  const actual = await original<typeof import("../../leadGen/aggregates")>();
  return {
    ...actual,
    applyLeadGenAggregateDelta: async (
      ...args: Parameters<typeof actual.applyLeadGenAggregateDelta>
    ) => {
      await actual.applyLeadGenAggregateDelta(...args);
      if (failure.voidFails)
        throw new Error("The day's totals can't be written right now");
    },
  };
});
afterEach(() => {
  failure.voidFails = false;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const NOW = Date.parse("2026-10-20T15:00:00Z");
const REEL = "https://www.instagram.com/reel/Cabc123/";
async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const h = await createMcpHarness();
  const seed = await seedTenantWithLeadGen(h.t);
  const agent = async (sub: string, orgId = seed.orgId) => {
    const token = await h.signToken(sub, { org_id: orgId });
    const { sessionId } = await mcpConnect(h.t, token);
    return (name: string, args: Record<string, unknown> = {}) =>
      callTool(h.t, token, sessionId, name, args);
  };
  const web = (sub: string, orgId = seed.orgId) =>
    h.t.withIdentity({ subject: sub, org_id: orgId });
  const capture = (handle = "maya.fit", sub = "user_sofia") =>
    web(sub).mutation(api.leadGen.capture.submit, {
      source: "instagram",
      rawHandleOrProfileUrl: handle,
      originKind: "follower",
    });
  const flags = () =>
    h.t.run((ctx) => ctx.db.query("leadGenCaptureFlags").take(100));
  const counts = () =>
    h.t.run(async (ctx) => ({
      stats: await ctx.db.query("leadGenDailyStats").take(100),
      prospects: await ctx.db.query("leadGenProspects").take(100),
      origins: await ctx.db.query("leadGenOriginStats").take(100),
    }));
  return { ...h, ...seed, agent, web, capture, flags, counts };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type FlagResult = {
  flag: {
    flagId: Id<"leadGenCaptureFlags">;
    state: string;
    reason: { text: string };
    createdAt: string;
  };
  alreadyFlagged: boolean;
  stillCounts: boolean;
};
async function flag(
  f: Fixture,
  submissionId: Id<"leadGenSubmissions">,
  reason = "Wrong post",
) {
  const agent = await f.agent("user_sofia");
  const result = await agent("magnus_flag_capture", { submissionId, reason });
  expect(result.isError, result.text).toBe(false);
  return result.data as FlagResult;
}
const listArgs = {
  requestKey: "list-1",
  source: "instagram",
  origin: { kind: "reel", value: REEL },
  handles: ["brand.new"],
};
type Preview = { preview: string; confirmToken: string; lines: unknown[] };

describe("capture flags through /mcp", () => {
  it("flags only the caller's capture, returns the original on changed-reason retries, and changes no counts or touches", async () => {
    const f = await fixture();
    const capture = await f.capture();
    const before = await f.counts();
    const person = await f.t.run((ctx) => ctx.db.get("leads", capture.leadId!));
    const first = await flag(f, capture.submissionId);
    expect(first).toMatchObject({
      alreadyFlagged: false,
      stillCounts: true,
      flag: { state: "open", reason: { text: "Wrong post" } },
    });
    expect(
      await flag(f, capture.submissionId, "Actually another reason"),
    ).toMatchObject({ ...first, alreadyFlagged: true });
    expect(await f.flags()).toHaveLength(1);
    expect(await f.counts()).toEqual(before);
    expect(
      await f.t.run((ctx) => ctx.db.get("leads", capture.leadId!)),
    ).toEqual(person);
    const events = await f.t.run((ctx) =>
      ctx.db.query("domainEvents").take(100),
    );
    const event = events.filter((e) => e.eventType === "lead.capture_flagged");
    expect(event).toHaveLength(1);
    expect(event[0]).toMatchObject({
      leadId: capture.leadId,
      actorUserId: f.sofiaId,
    });
    expect(JSON.parse(event[0].metadata!)).toMatchObject({
      via: "mcp",
      agentClient: "claude-ai",
    });
    expect(event[0].metadata).not.toContain("Wrong post");

    const otherCapture = await f.capture("dani.person", "user_dani");
    const own = await f.agent("user_sofia");
    expect(
      (
        await own("magnus_flag_capture", {
          submissionId: otherCapture.submissionId,
          reason: "Wrong post",
        })
      ).isError,
    ).toBe(true);
    const other = await seedTenantWithLeadGen(f.t, {
      orgId: "org_other",
      slug: "other",
    });
    const elsewhere = await f.agent("other_user_sofia", other.orgId);
    expect(
      (
        await elsewhere("magnus_flag_capture", {
          submissionId: capture.submissionId,
          reason: "Wrong post",
        })
      ).isError,
    ).toBe(true);
    for (const sub of ["user_admin", "user_alex", "user_owner"]) {
      const user = await f.agent(sub);
      const refused = await user("magnus_flag_capture", {
        submissionId: capture.submissionId,
        reason: "Wrong post",
      });
      expect(refused.isError || Boolean(refused.response.body?.error)).toBe(
        true,
      );
    }
    await f.t.run((ctx) =>
      ctx.db.patch("leadGenWorkers", f.sofiaWorkerId, { isActive: false }),
    );
    expect(
      (
        await own("magnus_flag_capture", {
          submissionId: capture.submissionId,
          reason: "Wrong post",
        })
      ).isError,
    ).toBe(true);
  });

  it.each(["aa", " ", "x".repeat(501)])(
    "refuses an invalid reason (%s)",
    async (reason) => {
      const f = await fixture();
      const capture = await f.capture();
      const own = await f.agent("user_sofia");
      expect(
        (
          await own("magnus_flag_capture", {
            submissionId: capture.submissionId,
            reason,
          })
        ).isError,
      ).toBe(true);
      expect(await f.flags()).toHaveLength(0);
    },
  );

  it.each(["void", "dismiss"] as const)(
    "keeps the first terminal state after flag then %s, including retries",
    async (action) => {
      const f = await fixture();
      const capture = await f.capture();
      const first = await flag(f, capture.submissionId);
      const admin = f.web("user_admin");
      const beforeCounts = await f.counts();
      if (action === "void") {
        await admin.mutation(api.leadGen.corrections.voidSubmission, {
          submissionId: capture.submissionId,
          reason: "Wrong post",
        });
        await admin.mutation(api.leadGen.captureFlags.dismiss, {
          flagId: first.flag.flagId,
          note: "Keep this",
        });
      } else {
        await admin.mutation(api.leadGen.captureFlags.dismiss, {
          flagId: first.flag.flagId,
          note: "Keep this",
        });
        expect(await f.counts()).toEqual(beforeCounts);
        expect(await flag(f, capture.submissionId)).toMatchObject({
          alreadyFlagged: true,
          stillCounts: true,
          flag: { state: "dismissed" },
        });
        await admin.mutation(api.leadGen.corrections.voidSubmission, {
          submissionId: capture.submissionId,
          reason: "Wrong post",
        });
      }
      const state = action === "void" ? "voided" : "dismissed";
      const retry = await flag(f, capture.submissionId, "New reason");
      expect(retry).toMatchObject({
        alreadyFlagged: true,
        stillCounts: false,
        flag: { state, reason: first.flag.reason },
      });
      const own = await f.agent("user_sofia");
      expect((await own("magnus_my_lead_gen_activity")).data).toMatchObject({
        recent: [{ voided: true, flag: { state } }],
      });
      const webRows = await f
        .web("user_sofia")
        .query(api.leadGen.activity.listMyRecentSubmissions, {
          paginationOpts: { cursor: null, numItems: 25 },
        });
      expect(webRows.page[0]).toMatchObject({
        isVoided: true,
        flag: { state },
      });
      const before = await f.flags();
      await admin.mutation(api.leadGen.captureFlags.dismiss, {
        flagId: first.flag.flagId,
        note: "A different note",
      });
      await admin.mutation(api.leadGen.corrections.voidSubmission, {
        submissionId: capture.submissionId,
        reason: "Repeat void",
      });
      expect(await f.flags()).toEqual(before);
    },
  );

  it("refuses void then flag and leaves the counts alone", async () => {
    const f = await fixture();
    const capture = await f.capture();
    await f.web("user_admin").mutation(api.leadGen.corrections.voidSubmission, {
      submissionId: capture.submissionId,
      reason: "Wrong post",
    });
    const before = await f.counts();
    const own = await f.agent("user_sofia");
    expect(
      (
        await own("magnus_flag_capture", {
          submissionId: capture.submissionId,
          reason: "Wrong post",
        })
      ).text,
    ).toContain("already voided");
    expect(await f.flags()).toHaveLength(0);
    expect(await f.counts()).toEqual(before);
  });

  it.each(["core", "mcp"] as const)(
    "repairs an open flag on an already-voided capture through %s without a second reversal",
    async (path) => {
      const f = await fixture();
      const capture = await f.capture();
      const first = await flag(f, capture.submissionId);
      await f
        .web("user_admin")
        .mutation(api.leadGen.corrections.voidSubmission, {
          submissionId: capture.submissionId,
          reason: "Wrong post",
        });
      await f.t.run((ctx) =>
        ctx.db.patch("leadGenCaptureFlags", first.flag.flagId, {
          state: "open",
          resolvedAt: undefined,
          resolvedByUserId: undefined,
        }),
      );
      const before = await f.counts();
      if (path === "core") {
        expect(
          await f
            .web("user_admin")
            .mutation(api.leadGen.corrections.voidSubmission, {
              submissionId: capture.submissionId,
              reason: "Repeat void",
            }),
        ).toMatchObject({ alreadyVoided: true });
      } else {
        const admin = await f.agent("user_admin");
        expect(
          (
            await admin("magnus_void_capture", {
              submissionId: capture.submissionId,
              reason: "Repeat void",
              confirm: false,
            })
          ).data,
        ).toMatchObject({ alreadyVoided: true });
      }
      expect(await f.flags()).toMatchObject([{ state: "voided" }]);
      expect(await f.counts()).toEqual(before);
    },
  );

  it("rolls flag closure and reversals back if a later void write fails, leaving its token usable", async () => {
    const f = await fixture();
    const capture = await f.capture();
    await flag(f, capture.submissionId);
    const admin = await f.agent("user_admin");
    const args = { submissionId: capture.submissionId, reason: "Wrong post" };
    const preview = (
      await admin("magnus_void_capture", { ...args, confirm: false })
    ).data as Preview;
    const before = await f.counts();
    failure.voidFails = true;
    const failed = await admin("magnus_void_capture", {
      ...args,
      confirm: true,
      confirmToken: preview.confirmToken,
    });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("can't be written");
    expect(await f.flags()).toMatchObject([{ state: "open" }]);
    expect(await f.counts()).toEqual(before);
    expect(
      await f.t.run((ctx) =>
        ctx.db.get("leadGenSubmissions", capture.submissionId),
      ),
    ).not.toHaveProperty("voidedAt");
    failure.voidFails = false;
    expect(
      (
        await admin("magnus_void_capture", {
          ...args,
          confirm: true,
          confirmToken: preview.confirmToken,
        })
      ).isError,
    ).toBe(false);
    expect(await f.flags()).toMatchObject([{ state: "voided" }]);
  });

  it("shows flags on web activity, submissions and admin handle checks, and redacts a dismissal note for the lead gen", async () => {
    const f = await fixture();
    const capture = await f.capture();
    const first = await flag(f, capture.submissionId);
    await f.web("user_admin").mutation(api.leadGen.captureFlags.dismiss, {
      flagId: first.flag.flagId,
      note: "Jordan Park checked USD 300 with Alex Rivera at alex@example.com",
    });
    const web = await f
      .web("user_sofia")
      .query(api.leadGen.activity.listMyRecentSubmissions, {
        paginationOpts: { cursor: null, numItems: 25 },
      });
    expect(web.page[0]).toMatchObject({
      submissionId: capture.submissionId,
      flag: {
        state: "dismissed",
        reason: "Wrong post",
        dismissal: {
          note: {
            text: "[staff] checked [amount] with [staff] at a•••@example.com",
          },
        },
      },
    });
    const own = await f.agent("user_sofia");
    const activity = await own("magnus_my_lead_gen_activity");
    expect(activity.isError, activity.text).toBe(false);
    expect(activity.data).toMatchObject({
      recent: [
        {
          submissionId: capture.submissionId,
          flag: { state: "dismissed", reason: { text: "Wrong post" } },
        },
      ],
    });
    expect(JSON.stringify(activity.data)).not.toMatch(
      /Jordan|Alex|USD 300|alex@example/,
    );
    const admin = await f.agent("user_admin");
    const submissions = await admin("magnus_lead_gen_submissions");
    expect(submissions.isError, submissions.text).toBe(false);
    expect(submissions.data).toMatchObject({
      rows: [
        {
          flag: {
            state: "dismissed",
            reason: { text: "Wrong post" },
            createdAt: expect.any(String),
          },
        },
      ],
    });
    const handles = await admin("magnus_check_handles", {
      handles: ["maya.fit"],
    });
    expect(handles.data).toMatchObject({
      results: [
        {
          captures: [
            { flag: { state: "dismissed", reason: { text: "Wrong post" } } },
          ],
        },
      ],
    });
  });

  it("gives lead gens only the contact date and admins the note, suppressing dates on forbidden people", async () => {
    const f = await fixture();
    const capture = await f.capture();
    await f.t.run((ctx) =>
      ctx.db.patch("leads", capture.leadId!, {
        contactAgain: {
          date: "2026-11-20",
          at: NOW + 86400000,
          timeZone: "America/Tegucigalpa",
          dayStartHour: 1,
          note: "Ask Jordan about USD 500",
          setByUserId: f.adminId,
          setAt: NOW,
        },
      }),
    );
    const own = await f.agent("user_sofia");
    const admin = await f.agent("user_admin");
    const args = { handles: ["maya.fit"] };
    const leadGen = await own("magnus_check_handles", args);
    expect(leadGen.data).toMatchObject({
      results: [{ contactAgain: { date: "2026-11-20" } }],
    });
    expect(JSON.stringify(leadGen.data)).not.toMatch(
      /Jordan|500|setBy|setAt|timeZone/,
    );
    expect((await admin("magnus_check_handles", args)).data).toMatchObject({
      results: [
        {
          contactAgain: {
            date: "2026-11-20",
            note: { text: "Ask Jordan about USD 500" },
          },
        },
      ],
    });
    await f.t.run((ctx) =>
      ctx.db.patch("leads", capture.leadId!, { disposition: "do_not_contact" }),
    );
    expect(
      JSON.stringify((await admin("magnus_check_handles", args)).data),
    ).not.toContain("contactAgain");
  });

  it("bounds joined queue documents without advancing past an omitted flag", async () => {
    const f = await fixture();
    const capture = await f.capture();
    await flag(f, capture.submissionId);
    await f.t.run((ctx) =>
      ctx.db.patch("leadGenWorkers", f.sofiaWorkerId, {
        displayName: "x".repeat(512 * 1024),
      }),
    );
    await expect(
      f
        .web("user_admin")
        .query(api.leadGen.captureFlags.listOpen, {
          paginationOpts: { cursor: null, numItems: 25 },
        }),
    ).rejects.toThrow("too large to load together");
    await f.t.run((ctx) =>
      ctx.db.patch("leadGenWorkers", f.sofiaWorkerId, {
        displayName: "Sofia Mendez",
      }),
    );
    const page = await f
      .web("user_admin")
      .query(api.leadGen.captureFlags.listOpen, {
        paginationOpts: { cursor: null, numItems: 25 },
      });
    expect(page.page).toMatchObject([
      { submissionId: capture.submissionId, state: "open" },
    ]);
  });

  it("pages more than 25 open flags without gaps and without a capture date filter", async () => {
    const f = await fixture();
    const own = await f.agent("user_sofia");
    for (let i = 0; i < 28; i++) {
      vi.setSystemTime(NOW + i * 6000);
      const capture = await f.capture(`person.${i}`);
      await f.t.run((ctx) =>
        ctx.db.patch("leadGenSubmissions", capture.submissionId, {
          submittedAt: NOW - 300 * 86400000,
        }),
      );
      expect(
        (
          await own("magnus_flag_capture", {
            submissionId: capture.submissionId,
            reason: `Wrong post ${i}`,
          })
        ).isError,
      ).toBe(false);
    }
    const other = await seedTenantWithLeadGen(f.t, {
      orgId: "org_other",
      slug: "other",
    });
    const admin = f.web("user_admin");
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const page: FunctionReturnType<typeof api.leadGen.captureFlags.listOpen> =
        await admin.query(api.leadGen.captureFlags.listOpen, {
          paginationOpts: { cursor, numItems: 25 },
        });
      expect(page.page.length).toBeLessThanOrEqual(25);
      seen.push(...page.page.map((row) => row.flagId));
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen).toHaveLength(28);
    expect(new Set(seen).size).toBe(28);
    expect(
      (
        await f
          .web("other_user_admin", other.orgId)
          .query(api.leadGen.captureFlags.listOpen, {
            paginationOpts: { cursor: null, numItems: 25 },
          })
      ).page,
    ).toHaveLength(0);
    await expect(
      f.web("user_sofia").query(api.leadGen.captureFlags.listOpen, {
        paginationOpts: { cursor: null, numItems: 25 },
      }),
    ).rejects.toThrow();
    const first = (await f.flags())[0];
    await expect(
      f.web("user_sofia").mutation(api.leadGen.captureFlags.dismiss, {
        flagId: first._id,
        note: "Keep it",
      }),
    ).rejects.toThrow();
    await expect(
      f
        .web("other_user_admin", other.orgId)
        .mutation(api.leadGen.captureFlags.dismiss, {
          flagId: first._id,
          note: "Keep it",
        }),
    ).rejects.toThrow();
    for (const note of ["aa", "x".repeat(501)])
      await expect(
        admin.mutation(api.leadGen.captureFlags.dismiss, {
          flagId: first._id,
          note,
        }),
      ).rejects.toThrow();
  }, 30_000);
});

describe("cached post identity in capture previews", () => {
  async function cache(
    f: Fixture,
    tenantId = f.tenantId,
    authorName = "Cole DaSilva",
    postedOn = "2026-03-01",
  ) {
    return f.t.run((ctx) =>
      ctx.db.insert("leadGenOriginPreviews", {
        tenantId,
        originKey: REEL.toLowerCase(),
        url: REEL,
        status: "ready",
        authorName,
        handle: "coleluisdasilva",
        postedOn,
        caption: "PRIVATE CAPTION",
        attempts: 1,
        requestedAt: NOW,
      }),
    );
  }
  it("uses cached author, handle and date only after numbered lines and never exposes captions or images", async () => {
    const f = await fixture();
    await cache(f);
    const own = await f.agent("user_sofia");
    const result = await own("magnus_capture_prospects", {
      ...listArgs,
      confirm: false,
    });
    expect(result.isError).toBe(false);
    const preview = result.data as Preview;
    const lines = preview.preview.split("\n");
    expect(lines[1]).toMatch(/^1\. @brand.new:/);
    expect(lines[1]).not.toMatch(/Cole|2026-03/);
    expect(lines[2]).toContain("Cole DaSilva");
    expect(lines[2]).toContain("@coleluisdasilva");
    expect(lines[2]).toContain("2026-03-01");
    expect(preview.preview).not.toMatch(/PRIVATE CAPTION|thumbnail|image/);
  });
  it("ignores another tenant's cache and missing cache, and accepts cache fill between preview and commit", async () => {
    const f = await fixture();
    const other = await seedTenantWithLeadGen(f.t, {
      orgId: "org_other",
      slug: "other",
    });
    await cache(f, other.tenantId);
    const own = await f.agent("user_sofia");
    const preview = (
      await own("magnus_capture_prospects", { ...listArgs, confirm: false })
    ).data as Preview;
    expect(preview.preview).not.toContain("Cole");
    await cache(f);
    const committed = await own("magnus_capture_prospects", {
      ...listArgs,
      confirm: true,
      confirmToken: preview.confirmToken,
    });
    expect(committed.isError, committed.text).toBe(false);
    expect(committed.data).toMatchObject({ saved: [{ handle: "brand.new" }] });
  });
  it("collapses multiline author and control text into one advisory line, ignores invalid dates, and still refuses a changed verdict", async () => {
    const f = await fixture();
    await cache(
      f,
      f.tenantId,
      "Cole\n2. pretend line\u2028Other\u0000 Name",
      "2026-02-31",
    );
    const own = await f.agent("user_sofia");
    const preview = (
      await own("magnus_capture_prospects", { ...listArgs, confirm: false })
    ).data as Preview;
    expect(
      preview.preview.split("\n").filter((line) => /^\d+\./.test(line)),
    ).toHaveLength(1);
    expect(preview.preview).toContain("Cole 2. pretend line Other Name");
    expect(preview.preview).not.toContain("2026-02-31");
    await f.capture("brand.new", "user_dani");
    const stale = await own("magnus_capture_prospects", {
      ...listArgs,
      confirm: true,
      confirmToken: preview.confirmToken,
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("Something changed since the preview");
  });
});
