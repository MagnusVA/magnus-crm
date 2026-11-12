import { describe, expect, it } from "vitest";
import {
  api,
  evalHarness,
  addCall,
  createCase,
  committedCase,
  foreignAdmin,
} from "../../../tests/callInsights/synthetic/evalHarness";

describe("quality campaign selection", () => {
  it("selects newest recordings, fills splits in order, and keeps one person in one split", async () => {
    const f = await evalHarness();
    for (let i = 1; i <= 62; i++) await addCall(f, i);
    await addCall(f, 99, { samePerson: true });
    await addCall(f, 100, { expiresAt: Date.now() + 13 * 86400000 });
    await addCall(f, 101, { published: false });
    const c = await f.owner.mutation(api.cases.createCampaign, {
      name: "Quality test",
    });
    expect(c).toMatchObject({ dev: 20, calib: 20, holdout: 20, capped: false });
    const list = await f.owner.query(api.cases.cases, { campaign: c.campaign });
    expect(list.cases).toHaveLength(60);
    expect(
      list.cases.filter((c) => c.split === "dev").map((c) => c.scheduledAt),
    ).toEqual(expect.arrayContaining([expect.any(Number)]));
    const stored = await f.t.run((ctx) =>
      ctx.db.query("callInsightEvalCases").take(100),
    );
    expect(new Set(stored.map((c) => c.groupKey)).size).toBe(60);
    expect(stored[0].recordingId).not.toBe(f.recordingId);
    expect(
      stored.every(
        (c) => c.candidateRunId && c.candidateConfig && c.status === "to_read",
      ),
    ).toBe(true);
    const again = await f.owner.mutation(api.cases.createCampaign, {
      name: "Next",
    });
    expect(again.dev).toBeLessThan(20);
    await expect(
      f.owner.mutation(api.cases.createCampaign, { name: "Next" }),
    ).rejects.toThrow();
  });
  it("fills only development when the backlog is small and records exposure", async () => {
    const f = await evalHarness({ settings: { mode: "on" } });
    const c = await createCase(f);
    const row = await f.owner.query(api.cases.caseForGrading, {
      caseId: c.caseId,
    });
    expect(row).toMatchObject({
      phase: "list",
      case: { exposedBeforeResult: true },
      transcript: { lineCount: 6 },
    });
    expect(row.candidates).toBeUndefined();
    expect(row.suggestion).toBeUndefined();
    expect(await f.admin.query(api.cases.campaigns, {})).toMatchObject({
      campaigns: [{ counts: { dev: 1 }, statuses: { to_read: 1 } }],
    });
  });
  it("rejects missing auth, closers, other tenants and expired cases", async () => {
    const f = await evalHarness();
    const c = await createCase(f);
    const other = await foreignAdmin(f);
    await expect(f.t.query(api.cases.campaigns, {})).rejects.toThrow();
    await expect(
      f.closer.mutation(api.cases.createCampaign, { name: "Denied" }),
    ).rejects.toThrow();
    for (const fn of [
      api.cases.campaigns,
      api.reports.latestReports,
      api.reports.capabilityStatus,
      api.wait.waitStudy,
    ])
      await expect(f.closer.query(fn, {})).rejects.toThrow();
    await expect(
      other.query(api.cases.caseForGrading, { caseId: c.caseId }),
    ).rejects.toThrow();
    expect(
      (await other.query(api.cases.cases, { campaign: c.campaign })).cases,
    ).toEqual([]);
    await f.t.run((ctx) =>
      ctx.db.patch("callInsightEvalCases", c.caseId, { purgeAt: 0 }),
    );
    await expect(
      f.owner.query(api.cases.caseForGrading, { caseId: c.caseId }),
    ).rejects.toThrow();
  });
});

describe("judge visibility on every query", () => {
  it("hides judge fields until commitment, including reopened cases", async () => {
    const f = await evalHarness();
    const c = await createCase(f);
    const labelId = await f.t.run((ctx) =>
      ctx.db.insert("callInsightEvalLabels", {
        tenantId: f.tenantId,
        caseId: c.caseId,
        source: "planted",
        itemClass: "income",
        judgeVerdict: "contradicted",
        judgeWrongFields: ["exists"],
        judgeLines: [3],
        labelRevision: 1,
        createdAt: Date.now(),
      }),
    );
    await f.t.run((ctx) =>
      ctx.db.patch("callInsightRuns", f.runId, {
        judgeOutput: "private-judge-canary",
      }),
    );
    const inspect = async () => {
      const responses = await Promise.all([
        f.owner.query(api.cases.campaigns, {}),
        f.owner.query(api.cases.cases, { campaign: c.campaign }),
        f.owner.query(api.cases.caseForGrading, { caseId: c.caseId }),
        f.owner.query(api.reports.latestReports, {}),
        f.owner.query(api.reports.capabilityStatus, {}),
        f.owner.query(api.wait.waitStudy, {}),
      ]);
      for (const r of responses) {
        expect(JSON.stringify(r)).not.toContain('"judgeVerdict"');
        expect(JSON.stringify(r)).not.toContain('"contradicted"');
        expect(JSON.stringify(r)).not.toContain("private-judge-canary");
        expect(JSON.stringify(r)).not.toContain('"judgeWrongFields"');
      }
    };
    await inspect();
    await f.owner.mutation(api.labels.commitList, {
      caseId: c.caseId,
      skipped: true,
    });
    await inspect();
    const labels = await f.t.run((ctx) =>
      ctx.db
        .query("callInsightEvalLabels")
        .withIndex("by_caseId_and_source", (q) =>
          q.eq("caseId", c.caseId).eq("source", "extractor"),
        )
        .take(100),
    );
    for (const label of labels)
      await f.owner.mutation(api.labels.gradeItem, {
        labelId: label._id,
        verdict: "right",
      });
    await f.owner.mutation(api.labels.commitLabels, { caseId: c.caseId });
    expect(
      (await f.owner.query(api.cases.caseForGrading, { caseId: c.caseId }))
        .judge,
    ).toEqual([
      { labelId, verdict: "contradicted", wrongFields: ["exists"], lines: [3] },
    ]);
    await f.owner.mutation(api.labels.reopenCase, { caseId: c.caseId });
    await inspect();
    expect(
      (await f.owner.query(api.cases.caseForGrading, { caseId: c.caseId }))
        .case,
    ).toMatchObject({ judgeExposed: true, labelRevision: 1 });
  });
  it("does not show expired or moved run quotes", async () => {
    const f = await evalHarness();
    const c = await committedCase(f);
    expect(
      (await f.owner.query(api.cases.caseForGrading, { caseId: c.caseId }))
        .candidates?.[0].quote,
    ).toBeTruthy();
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, { matchStatus: "ignored" }),
    );
    const view = await f.owner.query(api.cases.caseForGrading, {
      caseId: c.caseId,
    });
    expect(view.transcript.lineCount).toBe(0);
    expect(view.candidates?.every((c) => c.quote === undefined)).toBe(true);
  });
});

describe("authorized transcript pages", () => {
  it("pages the existing reader without a model answer and checks tenant access", async () => {
    const f = await evalHarness();
    const c = await createCase(f);
    const page = await f.owner.action(api.cases.transcriptPage, {
      caseId: c.caseId,
      page: 2,
      pageSize: 2,
    });
    expect(page).toMatchObject({ page: 2, pageCount: 3 });
    expect(page.lines).toHaveLength(2);
    expect(Object.keys(page.lines[0]).sort()).toEqual([
      "email",
      "speaker",
      "text",
      "timestamp",
    ]);
    const other = await foreignAdmin(f);
    for (const caller of [f.closer, other])
      await expect(
        caller.action(api.cases.transcriptPage, {
          caseId: c.caseId,
          page: 1,
          pageSize: 100,
        }),
      ).rejects.toThrow();
    await expect(
      f.owner.action(api.cases.transcriptPage, {
        caseId: c.caseId,
        page: 0,
        pageSize: 100,
      }),
    ).rejects.toThrow();
    await f.t.run((ctx) =>
      ctx.db.patch("callRecordings", f.recordingId, {
        transcriptDeletedAt: Date.now(),
      }),
    );
    expect(
      await f.owner.action(api.cases.transcriptPage, {
        caseId: c.caseId,
        page: 1,
        pageSize: 100,
      }),
    ).toEqual({ lines: [], page: 1, pageCount: 0 });
  });
});
