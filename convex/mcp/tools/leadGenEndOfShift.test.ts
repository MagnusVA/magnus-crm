import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FunctionReturnType } from "convex/server";
import { api, internal } from "../../_generated/api";
import { sha256Hex } from "../confirm";
import { insertResparkItem } from "../../lib/respark/items";
import { buildLeadGenShiftMessage } from "../../slack/leadGenShiftMessage";
import { package2Fixture, shiftChannel, SHIFT_DAY, SHIFT_NOW, DAY_MS, toolData, type Package2Fixture } from "../../../tests/leadGenPackage2Fixtures";

const failure = vi.hoisted(() => ({ afterSave: false }));
vi.mock("../../leadGen/endOfShift", async original => {
  const actual = await original<typeof import("../../leadGen/endOfShift")>();
  return { ...actual, endLeadGenShiftCore: async (...args: Parameters<typeof actual.endLeadGenShiftCore>) => {
    const result = await actual.endLeadGenShiftCore(...args);
    if (failure.afterSave) throw new Error("Injected failure after saving and queueing");
    return result;
  } };
});

const TOOL = "magnus_end_lead_gen_shift";
type Result = FunctionReturnType<typeof internal.mcp.tools.leadGenEndOfShift.endShift>;
type Preview = Extract<Result, { confirmToken: string }>;
type Receipt = Extract<Result, { ok: true }>;
const dictated = { narrative: "People asked to hear back next week.", note: "Please check tomorrow's bookings." };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(SHIFT_NOW); });
afterEach(() => { failure.afterSave = false; vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const preview = async (f: Package2Fixture, text = dictated) => toolData<Preview>(await f.tool(TOOL, { ...text, confirm: false }));
const commitArgs = (p: Preview, text = dictated) => ({ ...text, confirm: true, confirmToken: p.confirmToken, dayKey: p.dayKey, businessDayVersion: p.businessDayVersion });
const commit = async (f: Package2Fixture, p: Preview, text = dictated) => toolData<Receipt>(await f.tool(TOOL, commitArgs(p, text)));
const reports = (f: Package2Fixture) => f.t.run(ctx => ctx.db.query("leadGenShiftReports").take(100));
const postJobs = (f: Package2Fixture) => f.t.run(async ctx => (await ctx.db.system.query("_scheduled_functions").take(100))
  .filter(job => job.name === "slack/leadGenShiftReports:post"));
async function unused(f: Package2Fixture, token: string) {
  const hash = await sha256Hex(token);
  const row = await f.t.run(ctx => ctx.db.query("mcpConfirmations").withIndex("by_tokenHash", q => q.eq("tokenHash", hash)).unique());
  expect(row?.usedAt).toBeUndefined();
}
async function schedule(f: Package2Fixture, hours = 6) {
  await f.web("user_admin").mutation(api.workSchedules.setLeadGenWeeklySchedule, { workerId: f.sofiaWorkerId,
    scheduledHours: { monday: hours, tuesday: hours, wednesday: hours, thursday: hours, friday: hours, saturday: 0, sunday: 0 } });
}
async function seededDay(f: Package2Fixture) {
  await schedule(f);
  const a = await f.capture("shift.first"); await f.capture("shift.second");
  await f.t.run(async ctx => {
    const batchId = await ctx.db.insert("resparkBatches", { tenantId: f.tenantId, workerId: f.sofiaWorkerId, userId: f.sofiaId,
      createdAt: SHIFT_NOW, heldUntil: SHIFT_NOW + DAY_MS, size: 2, requestedSize: 2 });
    for (const [position, result] of ["resparked", "not_a_fit"].entries()) await insertResparkItem(ctx, {
      tenantId: f.tenantId, batchId, leadId: a.leadId!, workerId: f.sofiaWorkerId, userId: f.sofiaId, bucket: 1,
      position, result: result as "resparked" | "not_a_fit", workedAt: SHIFT_NOW, heldUntil: SHIFT_NOW + DAY_MS,
    });
  });
}

// Keep the harness's JWKS stub when intercepting Slack HTTP requests.
function slackFetch() {
  const previous = globalThis.fetch;
  const post = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>()
    .mockResolvedValue(Response.json({ ok: true, ts: "123.001" }));
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith("https://slack.com/") ? post(input, init) : previous(input, init));
  return post;
}
async function drain(f: Package2Fixture) {
  await f.t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("end of lead gen shift through /mcp", () => {
  it("counts the day, dedupes scheduled hours, saves only on confirmation and replays the same receipt", async () => {
    const f = await package2Fixture(); await seededDay(f);
    const p = await preview(f);
    expect(p).toMatchObject({ dayKey: SHIFT_DAY, businessDayVersion: 0, numbers: { rawLeads: 2, resparks: 1, entries: 3, notAFit: 1,
      scheduledHours: 6, leadsPerHour: 2 / 6 }, hoursStatus: "known", hoursUnknownReason: null });
    expect(await reports(f)).toHaveLength(0);
    const saved = await commit(f, p);
    expect(saved).toMatchObject({ ok: true, repeated: false, slackStatus: "not_configured", numbers: p.numbers });
    expect(saved.message).toContain("nothing was posted");
    expect(await commit(f, p)).toEqual(saved);
    const later = await preview(f, { narrative: "A new line must not replace the old report", note: "Changed note" });
    const again = await commit(f, later, { narrative: "A new line must not replace the old report", note: "Changed note" });
    expect(again.reportId).toBe(saved.reportId); expect(again.narrative).toBe(dictated.narrative);
    expect(await reports(f)).toHaveLength(1); expect(await postJobs(f)).toHaveLength(0);
    expect((await reports(f))[0]).toMatchObject({ via: "mcp", agentClient: "claude-ai", periodStart: Date.parse("2026-11-09T07:00:00Z"), asOf: SHIFT_NOW });
  });

  it("reads zero-capture hours independently and treats a complete missing schedule as zero", async () => {
    const f = await package2Fixture();
    const empty = await preview(f); expect(empty.numbers).toMatchObject({ rawLeads: 0, entries: 0, scheduledHours: 0, leadsPerHour: null });
    await schedule(f);
    const p = await preview(f); expect(p.numbers).toMatchObject({ rawLeads: 0, scheduledHours: 6, leadsPerHour: 0 });
    expect((await commit(f, p)).numbers).toEqual(p.numbers);
  });

  it.each(["rows", "bytes", "incomplete"])("keeps schedule hours unknown on %s and saves that fact explicitly", async mode => {
    const f = await package2Fixture();
    await f.t.run(async ctx => {
      for (let i = 0; i < (mode === "rows" ? 701 : mode === "bytes" ? 7 : 1); i++) await ctx.db.insert("leadGenWorkerSchedules", {
        tenantId: f.tenantId, workerId: f.sofiaWorkerId, userId: mode === "incomplete" ? f.daniId : f.sofiaId,
        weekday: "monday", scheduledHours: 6, effectiveFrom: mode === "bytes" ? "x".repeat(90_000) : `2020-${String(i).padStart(4, "0")}`,
        updatedAt: 0, updatedByUserId: f.adminId,
      });
    });
    const p = await preview(f);
    expect(p).toMatchObject({ hoursStatus: "unknown", hoursUnknownReason: mode === "rows" ? "row_limit" : mode === "bytes" ? "byte_limit" : "incomplete",
      numbers: { scheduledHours: null, leadsPerHour: null } });
    const r = await commit(f, p); expect(r.hoursStatus).toBe("unknown");
    const message = buildLeadGenShiftMessage((await reports(f))[0], "Sofia"); expect(message.text).toContain("Scheduled hours unknown");
  });

  it.each(["numbers", "day", "version", "settings", "channel", "text", "hours"])("refuses changed %s without using the token", async change => {
    const f = await package2Fixture(); const channel = await shiftChannel(f);
    if (change === "day") { vi.setSystemTime(Date.parse("2026-11-10T06:59:00Z")); f.tool = await f.agent(); }
    const p = await preview(f);
    let args = commitArgs(p);
    if (change === "numbers") await f.capture("late.capture");
    if (change === "day") { vi.setSystemTime(Date.parse("2026-11-10T07:01:00Z")); f.tool = await f.agent(); }
    if (change === "version") await f.t.run(ctx => ctx.db.patch("tenants", f.tenantId, { businessDayVersion: 1 }));
    if (change === "settings") await f.t.run(ctx => ctx.db.patch("tenants", f.tenantId, { businessDay: { timeZone: "America/New_York", dayStartHour: 1 } }));
    if (change === "channel") await f.t.run(ctx => ctx.db.patch("slackInstallations", channel, { leadGenNotifyChannelId: "C_NEW" }));
    if (change === "text") args = { ...args, narrative: "Changed lines" };
    if (change === "hours") await schedule(f);
    const result = await f.tool(TOOL, args); expect(result.isError).toBe(true);
    expect(await reports(f)).toHaveLength(0); await unused(f, p.confirmToken);
  });

  it("refuses a changed hours status without consuming the token", async () => {
    const f = await package2Fixture(); const p = await preview(f);
    await f.t.run(async ctx => {
      for (let i = 0; i < 701; i++) await ctx.db.insert("leadGenWorkerSchedules", { tenantId: f.tenantId, workerId: f.sofiaWorkerId,
        userId: f.sofiaId, weekday: "monday", scheduledHours: 6, updatedAt: 0, updatedByUserId: f.adminId });
    });
    expect((await f.tool(TOOL, commitArgs(p))).isError).toBe(true);
    await unused(f, p.confirmToken); expect(await reports(f)).toHaveLength(0);
  });

  it("replays a used token after midnight while an unused token refuses the rollover", async () => {
    const f = await package2Fixture(); const first = await preview(f); const second = await preview(f);
    const report = await commit(f, first);
    // Remain inside the token TTL across rollover.
    const nearMidnight = Date.parse("2026-11-10T06:59:00Z");
    vi.setSystemTime(nearMidnight);
    f.tool = await f.agent();
    const fresh = await preview(f);
    vi.setSystemTime(nearMidnight + 120_000);
    f.tool = await f.agent();
    expect(await commit(f, first)).toEqual(report);
    expect((await f.tool(TOOL, commitArgs(fresh))).isError).toBe(true); await unused(f, fresh.confirmToken);
    await unused(f, second.confirmToken);
  });

  it("converges two tokens to one immutable report and one queued Slack post", async () => {
    const f = await package2Fixture(); await shiftChannel(f); const a = await preview(f); const b = await preview(f);
    const first = await commit(f, a); const second = await commit(f, b);
    expect(second.reportId).toBe(first.reportId); expect(second.repeated).toBe(true);
    expect(await reports(f)).toHaveLength(1); expect(await postJobs(f)).toHaveLength(1);
    // A preview of a live pending post is receipt-only.
    const later = await preview(f); await commit(f, later); expect(await postJobs(f)).toHaveLength(1);
  });

  it("refuses the 101st daily bucket and blocks creation during a business-day rebuild", async () => {
    const f = await package2Fixture(); const p = await preview(f);
    await f.t.run(async ctx => {
      for (let i = 0; i < 101; i++) await ctx.db.insert("leadGenDailyStats", { tenantId: f.tenantId, workerId: f.sofiaWorkerId, userId: f.sofiaId,
        statKey: `bucket${i}`, dayKey: SHIFT_DAY, source: "instagram", submissions: 1, uniqueProspectsSubmitted: 1, duplicateProspectSubmissions: 0, scheduledHours: 6, updatedAt: 0 });
    });
    expect((await f.tool(TOOL, commitArgs(p))).isError).toBe(true); await unused(f, p.confirmToken); expect(await reports(f)).toHaveLength(0);
    expect((await f.tool(TOOL, { confirm: false })).isError).toBe(true);
    // Rebuild guard is exercised in a fresh fixture to isolate it from the row cap.
    const g = await package2Fixture();
    await g.t.run(ctx => ctx.db.insert("businessDayRebuilds", { tenantId: g.tenantId, version: 1, state: "running", sourceRevision: 0,
      requestedAt: SHIFT_NOW, phase: "seed_daily", cursor: null, pass: 0, computedRevision: 0,
      meetingsEnqueued: 0, leadGenRowsComputed: 0, leadGenRowsSwapped: 0, leadGenAudited: 0,
      meetingsAsserted: 0, bucketsAsserted: 0, sourcesAsserted: 0, leadGenDone: false }));
    expect((await g.tool(TOOL, { confirm: false })).isError).toBe(true);
  });

  it.each(["user_dani", "user_admin", "user_alex"])("protects Sofia's token from %s", async sub => {
    const f = await package2Fixture(); const p = await preview(f); const agent = await f.agent(sub);
    const result = await agent(TOOL, commitArgs(p)); expect(result.isError || Boolean(result.response.body?.error)).toBe(true);
    await unused(f, p.confirmToken); expect(await reports(f)).toHaveLength(0);
  });

  it("rolls back the saved report, queued post and token on a late failure", async () => {
    const f = await package2Fixture(); await shiftChannel(f); const p = await preview(f);
    failure.afterSave = true;
    expect((await f.tool(TOOL, commitArgs(p))).isError).toBe(true);
    expect(await reports(f)).toHaveLength(0); expect(await postJobs(f)).toHaveLength(0);
    await unused(f, p.confirmToken);
    failure.afterSave = false;
    expect((await commit(f, p)).ok).toBe(true);
  });

  it("uses the tenant's DST business day instead of the worker's time zone", async () => {
    const f = await package2Fixture();
    await f.t.run(async ctx => {
      await ctx.db.patch("tenants", f.tenantId, { businessDay: { timeZone: "America/New_York", dayStartHour: 1 }, businessDayVersion: 3 });
      await ctx.db.patch("users", f.sofiaId, { timezone: "Asia/Tokyo" });
    });
    vi.setSystemTime(Date.parse("2026-11-01T17:00:00Z")); f.tool = await f.agent();
    const p = await preview(f); expect(p).toMatchObject({ dayKey: "2026-11-01", businessDayVersion: 3 });
    const r = await commit(f, p); expect(r.timeZone).toBe("America/New_York");
    expect((await reports(f))[0].periodStart).toBe(Date.parse("2026-11-01T05:00:00Z"));
  });

  it("rejects long text and a commit without its token", async () => {
    const f = await package2Fixture();
    expect((await f.tool(TOOL, { confirm: false, narrative: "x".repeat(501) })).isError).toBe(true);
    expect((await f.tool(TOOL, { confirm: true })).isError).toBe(true);
    expect(await reports(f)).toHaveLength(0);
  });
});

describe("lead gen shift Slack delivery", () => {
  it("posts the saved snapshot as plain text without mentions or unfurls, then refuses duplicate posts", async () => {
    const f = await package2Fixture(); await shiftChannel(f); const post = slackFetch();
    const text = { narrative: "<!channel> <@U1> *please* <https://example.com|open>", note: "& team" };
    const p = await preview(f, text); const r = await commit(f, p, text); await drain(f);
    expect((await reports(f))[0]).toMatchObject({ slackStatus: "posted", slackTs: "123.001" });
    expect(post).toHaveBeenCalledTimes(1); const body = JSON.parse(post.mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({ channel: "C_LEAD_GEN", unfurl_links: false, unfurl_media: false, mrkdwn: false, parse: "none", link_names: false });
    expect(body.text).not.toContain("<!channel>"); expect(body.blocks[0].text.type).toBe("plain_text");
    await f.t.action(internal.slack.leadGenShiftReports.post, { reportId: r.reportId }); expect(post).toHaveBeenCalledTimes(1);
  });

  it("retries a failed post from the same call with the same message id and saved text", async () => {
    const f = await package2Fixture(); await shiftChannel(f); const post = slackFetch();
    post.mockRejectedValueOnce(new Error("Network unavailable"));
    const r = await commit(f, await preview(f)); await drain(f);
    expect((await reports(f))[0].slackStatus).toBe("failed");
    const retry = await preview(f, { narrative: "Must not replace saved lines", note: "" });
    expect((await commit(f, retry, { narrative: "Must not replace saved lines", note: "" })).reportId).toBe(r.reportId);
    await drain(f); expect((await reports(f))[0]).toMatchObject({ slackStatus: "posted", narrative: dictated.narrative });
    const messages = post.mock.calls.map(call => JSON.parse(call[1]!.body as string));
    expect(messages).toHaveLength(2); expect(messages[1].client_msg_id).toBe(messages[0].client_msg_id);
    expect(messages[1].text).toBe(messages[0].text);
  });

  it("retries a previously unconfigured report after a channel is set", async () => {
    const f = await package2Fixture(); const r = await commit(f, await preview(f)); await shiftChannel(f); const post = slackFetch();
    const p = await preview(f); const retry = await commit(f, p);
    expect(retry.reportId).toBe(r.reportId); expect(retry.slackStatus).toBe("pending");
    await drain(f); expect(post).toHaveBeenCalledTimes(1); expect((await reports(f))[0].slackStatus).toBe("posted");
  });

  it("retries a stale pending lease and ignores its old attempt's completion", async () => {
    const f = await package2Fixture(); await shiftChannel(f); const post = slackFetch(); const r = await commit(f, await preview(f));
    await f.t.run(ctx => ctx.db.patch("leadGenShiftReports", r.reportId, { slackPostStartedAt: SHIFT_NOW - 120_000, slackPostAttempt: "old-attempt" }));
    const p = await preview(f); await commit(f, p);
    await f.t.mutation(internal.slack.leadGenShiftReports.completePost, { reportId: r.reportId, channelId: "C_LEAD_GEN", attempt: "old-attempt", ts: "stale" });
    expect((await reports(f))[0].slackStatus).toBe("pending");
    await drain(f); expect(post).toHaveBeenCalledTimes(1); expect((await reports(f))[0]).toMatchObject({ slackStatus: "posted", slackTs: "123.001" });
  });

  it("claims a post once per lease and keeps a changed installation's error state", async () => {
    const f = await package2Fixture(); const channel = await shiftChannel(f); const r = await commit(f, await preview(f));
    const claim = { reportId: r.reportId, channelId: "C_LEAD_GEN", attempt: "first" };
    expect(await f.t.mutation(internal.slack.leadGenShiftReports.claimPost, claim)).toBe(true);
    expect(await f.t.mutation(internal.slack.leadGenShiftReports.claimPost, { ...claim, attempt: "second" })).toBe(false);
    await f.t.run(ctx => ctx.db.patch("slackInstallations", channel, { leadGenNotifyChannelId: "C_NEW" }));
    await f.t.mutation(internal.slack.leadGenShiftReports.completePost, { ...claim, error: "channel_not_found" });
    expect((await reports(f))[0].slackStatus).toBe("failed");
    const installation = await f.t.run(ctx => ctx.db.get("slackInstallations", channel));
    expect(installation?.leadGenNotifyChannelId).toBe("C_NEW"); expect(installation?.leadGenNotifyChannelError).toBeUndefined();
  });

  it("does not redirect an already queued post when its channel changes", async () => {
    const f = await package2Fixture(); const channel = await shiftChannel(f); const post = slackFetch();
    await commit(f, await preview(f));
    await f.t.run(ctx => ctx.db.patch("slackInstallations", channel, { leadGenNotifyChannelId: "C_NEW" }));
    await drain(f); expect(post).not.toHaveBeenCalled();
    expect((await reports(f))[0]).toMatchObject({ slackStatus: "failed", slackError: "channel_changed_or_disconnected" });
  });

  it.each(["channel_not_found", "not_in_channel", "is_archived"])("records %s only on the lead gen channel", async error => {
    const f = await package2Fixture(); const channel = await shiftChannel(f); const post = slackFetch();
    post.mockResolvedValue(Response.json({ ok: false, error }));
    await commit(f, await preview(f)); await drain(f);
    const installation = await f.t.run(ctx => ctx.db.get("slackInstallations", channel));
    expect(installation).toMatchObject({ notifyChannelId: "C_OTHER", eodReportChannelId: "C_CLOSER", leadGenNotifyChannelError: { code: error, channelId: "C_LEAD_GEN" } });
    expect(installation?.leadGenNotifyChannelId).toBe(error === "not_in_channel" ? "C_LEAD_GEN" : undefined);
  });
});
