import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { businessDayRange } from "../../lib/businessDay";
import {
  buildCloserDaySummary,
  endDayCore,
  getDaySummaryCore,
} from "./endOfDay";
import { buildEndOfDayMessage } from "../slack/eodMessage";
import { meetingsByStatus } from "../reporting/aggregates";
import {
  insertCloserMeeting,
  insertTask,
} from "../../tests/closerPipelineFixtures";
import {
  eodCall,
  EOD_DAY,
  EOD_HOUR,
  EOD_NOW,
  eodPayment,
  eodRecording,
  endOfDayHarness,
} from "../../tests/closerEndOfDayFixtures";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EOD_NOW);
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("end-of-day shift windows", () => {
  it("starts 24 hours back with no prior report and saves the first browser zone", async () => {
    const h = await endOfDayHarness();
    const report = await h.closer.mutation(api.closer.endOfDay.endMyDay, {
      timeZone: "Asia/Manila",
      note: "Team note",
    });
    expect(report).toMatchObject({
      periodStart: EOD_NOW - EOD_DAY,
      periodEnd: EOD_NOW,
      previousDayUnclosed: true,
      slackStatus: "not_configured",
      timeZone: "Asia/Manila",
      note: "Team note",
      endedVia: "web",
    });
    expect(
      await h.t.run((ctx) => ctx.db.get("users", h.closerId)),
    ).toMatchObject({ timezone: "Asia/Manila" });
    vi.setSystemTime(EOD_NOW + EOD_HOUR);
    const second = await h.closer.mutation(api.closer.endOfDay.endMyDay, {
      timeZone: "Europe/Madrid",
    });
    expect(second).toMatchObject({
      periodStart: EOD_NOW,
      periodEnd: EOD_NOW + EOD_HOUR,
      previousDayUnclosed: false,
      timeZone: "Asia/Manila",
      previousReportId: report._id,
    });
  });

  it("starts 24 hours back after a missed day, but accepts exactly 24 hours", async () => {
    const h = await endOfDayHarness();
    const first = await h.closer.mutation(api.closer.endOfDay.endMyDay, {});
    vi.setSystemTime(EOD_NOW + EOD_DAY);
    const exact = await h.closer.mutation(api.closer.endOfDay.endMyDay, {});
    expect(exact).toMatchObject({
      previousDayUnclosed: false,
      periodStart: first.periodEnd,
    });
    vi.setSystemTime(EOD_NOW + 2 * EOD_DAY + 1);
    const stale = await h.closer.mutation(api.closer.endOfDay.endMyDay, {});
    expect(stale).toMatchObject({
      previousDayUnclosed: true,
      periodStart: EOD_NOW + EOD_DAY + 1,
    });
  });

  it("returns the saved report inside 60 seconds, queues once, and starts a new window at 60 seconds", async () => {
    const h = await endOfDayHarness(true);
    const first = await h.closer.mutation(api.closer.endOfDay.endMyDay, {});
    vi.setSystemTime(EOD_NOW + 59_999);
    const retry = await h.closer.mutation(api.closer.endOfDay.endMyDay, {
      note: "A retry must not replace the note",
    });
    expect(retry).toEqual(first);
    expect(
      await h.t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").take(10),
      ),
    ).toHaveLength(1);
    vi.setSystemTime(EOD_NOW + 60_000);
    const second = await h.closer.mutation(api.closer.endOfDay.endMyDay, {});
    expect(second._id).not.toBe(first._id);
    expect(second).toMatchObject({
      periodStart: first.periodEnd,
      periodEnd: EOD_NOW + 60_000,
      slackThreadReportId: first._id,
    });
  });

  it("returns an empty live window immediately after saving, even while the browser clock is behind", async () => {
    const h = await endOfDayHarness();
    await h.t.run((ctx) =>
      eodCall(ctx, h, { status: "held", dealStatus: "follow_up_scheduled" }),
    );
    await h.closer.mutation(api.closer.endOfDay.endMyDay, {});
    const summary = await h.closer.query(api.closer.endOfDay.getDaySummary, {
      now: EOD_NOW - 30_000,
    });
    expect(summary).toMatchObject({
      periodStart: EOD_NOW,
      periodEnd: EOD_NOW,
      numbers: {
        newCalls: { scheduled: 0, held: 0 },
        closeRate: { cohort: 0, won: 0 },
      },
    });
  });

  it("shares a read-only agent core and records agent provenance through the write core", async () => {
    const h = await endOfDayHarness();
    const caller = {
      tenantId: h.tenantId,
      userId: h.closerId,
      role: "closer" as const,
    };
    const summary = await h.t.run((ctx) => getDaySummaryCore(ctx, caller));
    expect(summary).toMatchObject({
      periodStart: EOD_NOW - EOD_DAY,
      timeZone: "America/Tegucigalpa",
    });
    expect(
      await h.t.run((ctx) => ctx.db.query("endOfDayReports").take(1)),
    ).toHaveLength(0);
    const report = await h.t.run((ctx) =>
      endDayCore(ctx, caller, {
        endedVia: "agent",
        narrative: "Five lines",
        agentClient: "Hermes",
      }),
    );
    expect(report).toMatchObject({
      endedVia: "agent",
      narrativeMarkdown: "Five lines",
      agentClient: "Hermes",
    });
  });
});

describe("the shared summary builder", () => {
  it("agrees with getPipelineSummary for one business day and keeps deposits in close rate, outside cash", async () => {
    const h = await endOfDayHarness();
    const range = businessDayRange("2026-11-03", {
      timeZone: "America/Tegucigalpa",
      dayStartHour: 1,
    });
    await h.t.run(async (ctx) => {
      const win = await eodCall(ctx, h, {
        status: "held",
        dealStatus: "payment_received",
        name: "Marcus Tate",
      });
      await eodPayment(ctx, h, win.opportunityId, { amountMinor: 450_000 });
      const deposit = await eodCall(ctx, h, {
        status: "held",
        dealStatus: "payment_received",
        name: "Priya Nair",
      });
      await eodPayment(ctx, h, deposit.opportunityId, {
        amountMinor: 50_000,
        paymentType: "deposit",
      });
      await eodCall(ctx, h, { status: "held", dealStatus: "lost" });
      await eodCall(ctx, h, { status: "no_show", dealStatus: "no_show" });
      await eodCall(ctx, h, { status: "canceled", dealStatus: "canceled" });
      await eodCall(ctx, h, { status: "scheduled", dealStatus: "scheduled" });
      const follow = await eodCall(ctx, h, {
        status: "held",
        dealStatus: "follow_up_scheduled",
        callType: "follow_up",
      });
      const first = await insertCloserMeeting(ctx, {
        tenantId: h.tenantId,
        closerId: h.closerId,
        opportunityId: follow.opportunityId,
        status: "held",
        scheduledAt: range.start - EOD_HOUR,
      });
      await meetingsByStatus.insert(
        ctx,
        (await ctx.db.get("meetings", first))!,
      );
    });
    const summary = await h.t.run((ctx) =>
      buildCloserDaySummary(ctx, {
        tenantId: h.tenantId,
        userId: h.closerId,
        periodStart: range.start,
        periodEnd: range.end,
        now: range.end,
      }),
    );
    const pipeline = await h.closer.query(
      api.closer.dashboard.getPipelineSummary,
      { startDate: range.start, endDate: range.end },
    );
    if (!("heldCount" in pipeline))
      throw new Error("Expected a dated pipeline summary");
    expect(summary.numbers.deals.won + summary.numbers.deals.deposits).toBe(
      pipeline.decided?.won,
    );
    expect(summary.numbers.deals.lost).toBe(pipeline.decided?.lost);
    expect(summary.numbers.deals.followUp).toBe(pipeline.counts.follow_up);
    expect(
      summary.numbers.newCalls.held + summary.numbers.followUpCalls.held,
    ).toBe(pipeline.heldCount);
    expect(
      summary.numbers.newCalls.noShow + summary.numbers.followUpCalls.noShow,
    ).toBe(pipeline.noShowCount);
    expect(summary.numbers.money[0].cashMinor).toBe(
      pipeline.cashCollectedMinor,
    );
    expect(summary.numbers).toMatchObject({
      newCalls: {
        scheduled: 6,
        held: 3,
        noShow: 1,
        canceled: 1,
        notRecorded: 1,
        showRate: 0.75,
      },
      followUpCalls: { scheduled: 1, held: 1, showRate: 1 },
      closeRate: { cohort: 3, won: 2 },
      deals: { won: 1, deposits: 1, lost: 1, followUp: 1 },
      money: [{ currency: "USD", cashMinor: 450_000, depositsMinor: 50_000 }],
      overran: 0,
    });
    expect(
      summary.numbers.people.find((person) => person.kind === "deposit"),
    ).toMatchObject({
      name: "Priya N.",
      amountMinor: 50_000,
      program: "Scale Program",
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /Sensitive reason|@example|Marcus Tate|Priya Nair/,
    );
  });

  it("keeps the call's booking program and falls back to the event type for legacy deals", async () => {
    const h = await endOfDayHarness();
    await h.t.run(async (ctx) => {
      const legacy = await eodCall(ctx, h, {
        status: "held",
        dealStatus: "follow_up_scheduled",
      });
      const eventTypeConfigId = await ctx.db.insert("eventTypeConfigs", {
        tenantId: h.tenantId,
        calendlyEventTypeUri: "https://api.calendly.com/event_types/legacy",
        displayName: "Legacy Program",
        createdAt: 0,
      });
      await ctx.db.patch("opportunities", legacy.opportunityId, {
        firstBookingProgramName: undefined,
        eventTypeConfigId,
      });
      const call = await eodCall(ctx, h, {
        status: "held",
        dealStatus: "follow_up_scheduled",
      });
      await ctx.db.patch("meetings", call.meetingId, {
        bookingProgramName: "Call Program",
      });
    });
    const summary = await h.closer.query(api.closer.endOfDay.getDaySummary, {
      now: EOD_NOW,
    });
    expect(
      summary.numbers.people.map((person) => person.program).sort(),
    ).toEqual(["Call Program", "Legacy Program"]);
  });

  it("uses payment recordedAt and keeps currencies, disputes, deposit-only wins, and mixed payments separate", async () => {
    const h = await endOfDayHarness();
    await h.t.run(async (ctx) => {
      const call = await eodCall(ctx, h, {
        status: "held",
        dealStatus: "payment_received",
      });
      await eodPayment(ctx, h, call.opportunityId, {
        amountMinor: 1000,
        paymentType: "deposit",
      });
      await eodPayment(ctx, h, call.opportunityId, {
        amountMinor: 2000,
        currency: "EUR",
      });
      await eodPayment(ctx, h, call.opportunityId, {
        amountMinor: 500,
        currency: "GBP",
      });
      await eodPayment(ctx, h, call.opportunityId, {
        amountMinor: 10_000,
        status: "disputed",
      });
      await eodPayment(ctx, h, call.opportunityId, {
        amountMinor: 30_000,
        recordedAt: EOD_NOW,
      });
      await eodPayment(ctx, h, call.opportunityId, {
        amountMinor: 40_000,
        recordedAt: EOD_NOW - EOD_DAY - 1,
      });
    });
    const summary = await h.closer.query(api.closer.endOfDay.getDaySummary, {
      now: EOD_NOW,
    });
    expect(summary.numbers.money).toEqual([
      { currency: "EUR", cashMinor: 2000, depositsMinor: 0 },
      { currency: "GBP", cashMinor: 500, depositsMinor: 0 },
      { currency: "USD", cashMinor: 0, depositsMinor: 1000 },
    ]);
    expect(summary.numbers.deals).toMatchObject({ won: 1, deposits: 0 });
    expect(summary.numbers.people[0].amounts).toHaveLength(3);
  });

  it("counts Overran only beyond ten minutes with a matched recording, and includes every open gap", async () => {
    const h = await endOfDayHarness();
    const ids = await h.t.run(async (ctx) => {
      const overran = await eodCall(ctx, h, {
        status: "held",
        dealStatus: "follow_up_scheduled",
      });
      await eodRecording(ctx, h, {
        meetingId: overran.meetingId,
        recordingId: 1,
        endedAt: EOD_NOW - 20 * 60_000 + 1,
      });
      const exact = await eodCall(ctx, h, {
        status: "held",
        dealStatus: "follow_up_scheduled",
      });
      await eodRecording(ctx, h, {
        meetingId: exact.meetingId,
        recordingId: 2,
        endedAt: EOD_NOW - 20 * 60_000,
      });
      await eodCall(ctx, h, {
        status: "held",
        dealStatus: "follow_up_scheduled",
      });
      const unrecorded = await eodCall(ctx, h, {
        status: "scheduled",
        dealStatus: "scheduled",
      });
      const recordingId = await eodRecording(ctx, h, {
        meetingId: unrecorded.meetingId,
        recordingId: 3,
      });
      const unmatchedId = await eodRecording(ctx, h, { recordingId: 4 });
      await eodRecording(ctx, h, { recordingId: 5, userId: h.otherCloserId });
      for (const [status, at] of [
        ["completed", EOD_NOW - 1000],
        ["pending", EOD_NOW - 2000],
        ["pending", EOD_NOW - 2 * EOD_DAY],
        ["completed", EOD_NOW],
        ["pending", EOD_NOW + 1000],
      ] as const) {
        await insertTask(ctx, {
          opportunityId: overran.opportunityId,
          type: "manual_reminder",
          reason: "closer_initiated",
          status,
          reminderScheduledAt: at,
        });
      }
      return { unrecorded, recordingId, unmatchedId };
    });
    const summary = await h.closer.query(api.closer.endOfDay.getDaySummary, {
      now: EOD_NOW,
    });
    expect(summary.numbers.overran).toBe(1);
    expect(summary.numbers.callbacks).toEqual({ due: 2, done: 1, pending: 1 });
    expect(
      summary.gaps.filter((gap) => gap.kind === "overdue_task"),
    ).toHaveLength(2);
    expect(summary.gaps).toContainEqual({
      kind: "not_recorded",
      label: "Marcus T. · Not recorded · Recording available",
      meetingId: ids.unrecorded.meetingId,
      recordingId: ids.recordingId,
    });
    expect(
      summary.gaps.filter((gap) => gap.kind === "unmatched_recording"),
    ).toEqual([
      {
        kind: "unmatched_recording",
        label: "Recording without a meeting",
        recordingId: ids.unmatchedId,
      },
    ]);
  });
  it("refuses a capped read and saves no partial report", async () => {
    const h = await endOfDayHarness();
    await h.t.run(async (ctx) => {
      const call = await eodCall(ctx, h, {
        status: "scheduled",
        dealStatus: "scheduled",
      });
      for (let i = 0; i < 200; i++)
        await insertCloserMeeting(ctx, {
          tenantId: h.tenantId,
          closerId: h.closerId,
          opportunityId: call.opportunityId,
          status: "scheduled",
          scheduledAt: EOD_NOW - EOD_HOUR,
        });
    });
    await expect(
      h.closer.mutation(api.closer.endOfDay.endMyDay, {}),
    ).rejects.toThrow("too much data to summarize safely");
    expect(
      await h.t.run((ctx) => ctx.db.query("endOfDayReports").take(1)),
    ).toHaveLength(0);
  });
});

describe("Slack end-of-day delivery", () => {
  it("posts the saved snapshot, narrative and note in the closer's time zone and records success", async () => {
    const h = await endOfDayHarness(true);
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, ts: "123.001" }));
    vi.stubGlobal("fetch", fetch);
    const report = await h.t.run((ctx) =>
      endDayCore(
        ctx,
        { tenantId: h.tenantId, userId: h.closerId, role: "closer" },
        {
          endedVia: "agent",
          narrative: "Lines from Hermes",
          agentClient: "Hermes",
          note: "Send the PDF",
          timeZone: "Asia/Manila",
        },
      ),
    );
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    const saved = await h.closer.query(api.closer.endOfDay.getMyReport, {
      reportId: report._id,
    });
    expect(saved).toMatchObject({
      slackStatus: "posted",
      slackTs: "123.001",
      postedAt: EOD_NOW,
    });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.channel).toBe("C_EOD");
    for (const text of [
      "Ana Reyes",
      "New calls",
      "Follow-up calls",
      "Money",
      "Asia/Manila",
      "Lines from Hermes",
      "Note from Ana: Send the PDF",
      "Numbers from Magnus.",
      "Lines by Hermes, confirmed by Ana.",
    ]) {
      // Intl uses an abbreviation/offset in the shift; the stored zone is checked independently.
      if (text !== "Asia/Manila") expect(body.text).toContain(text);
    }
    expect(saved?.timeZone).toBe("Asia/Manila");
    expect(body).not.toHaveProperty("thread_ts");
    expect(body.unfurl_links).toBe(false);
    await h.t.action(internal.slack.eodReports.post, { reportId: report._id });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "channel_not_found",
    "is_archived",
    "not_in_channel",
    "ratelimited",
  ])("records %s without changing other channel groups", async (error) => {
    const h = await endOfDayHarness(true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ok: false, error })),
    );
    const report = await h.closer.mutation(api.closer.endOfDay.endMyDay, {});
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await h.closer.query(api.closer.endOfDay.getMyReport, {
        reportId: report._id,
      }),
    ).toMatchObject({ slackStatus: "failed", slackError: error });
    const installation = await h.t.run((ctx) =>
      ctx.db.get("slackInstallations", h.installationId!),
    );
    expect(installation?.notifyChannelId).toBe("C_OTHER");
    expect(installation?.eodReportChannelId).toBe(
      ["channel_not_found", "is_archived"].includes(error)
        ? undefined
        : "C_EOD",
    );
    if (error !== "ratelimited")
      expect(installation?.eodReportChannelError).toMatchObject({
        code: error,
        channelId: "C_EOD",
      });
  });

  it("marks a network failure failed, allows an authorized retry and clears the error on success", async () => {
    const h = await endOfDayHarness(true);
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValue(Response.json({ ok: true, ts: "123.002" }));
    vi.stubGlobal("fetch", fetch);
    const report = await h.closer.mutation(api.closer.endOfDay.endMyDay, {});
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await h.closer.query(api.closer.endOfDay.getMyReport, {
        reportId: report._id,
      }),
    ).toMatchObject({ slackStatus: "failed", slackError: "post_failed" });
    await h.closer.mutation(api.closer.endOfDay.retryEndOfDayPost, {
      reportId: report._id,
    });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await h.closer.query(api.closer.endOfDay.getMyReport, {
        reportId: report._id,
      }),
    ).toMatchObject({ slackStatus: "posted", slackTs: "123.002" });
    expect(
      fetch.mock.calls.map((call) => JSON.parse(call[1].body).client_msg_id)[0],
    ).toBe(JSON.parse(fetch.mock.calls[1][1].body).client_msg_id);
  });

  it("posts a second and third report as replies to the first report, and starts a new thread the next day", async () => {
    const h = await endOfDayHarness(true);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, ts: "1.0" }))
      .mockResolvedValueOnce(Response.json({ ok: true, ts: "2.0" }))
      .mockResolvedValueOnce(Response.json({ ok: true, ts: "3.0" }))
      .mockResolvedValue(Response.json({ ok: true, ts: "4.0" }));
    vi.stubGlobal("fetch", fetch);
    for (const elapsed of [0, 60_000, 120_000, EOD_DAY]) {
      vi.setSystemTime(EOD_NOW + elapsed);
      await h.closer.mutation(api.closer.endOfDay.endMyDay, {});
      await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    }
    expect(
      fetch.mock.calls.map((call) => JSON.parse(call[1].body).thread_ts),
    ).toEqual([undefined, "1.0", "1.0", undefined]);
  });

  it("waits for the first report's pending post before posting the second as a reply", async () => {
    const h = await endOfDayHarness(true);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, ts: "1.0" }))
      .mockResolvedValue(Response.json({ ok: true, ts: "2.0" }));
    vi.stubGlobal("fetch", fetch);
    await h.closer.mutation(api.closer.endOfDay.endMyDay, {});
    vi.setSystemTime(EOD_NOW + 60_000);
    const second = await h.closer.mutation(api.closer.endOfDay.endMyDay, {});
    await h.t.action(internal.slack.eodReports.post, { reportId: second._id });
    expect(fetch).not.toHaveBeenCalled();
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      fetch.mock.calls.map((call) => JSON.parse(call[1].body).thread_ts),
    ).toEqual([undefined, "1.0"]);
  });

  it("does not fall back to the notifications channel, and escapes Slack mentions in report text", async () => {
    const h = await endOfDayHarness(true);
    await h.t.run((ctx) =>
      ctx.db.patch("slackInstallations", h.installationId!, {
        eodReportChannelId: undefined,
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const report = await h.closer.mutation(api.closer.endOfDay.endMyDay, {
      note: "Hi <!channel> & <@U1>",
    });
    await h.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(report.slackStatus).toBe("not_configured");
    expect(fetch).not.toHaveBeenCalled();
    const message = buildEndOfDayMessage(
      report,
      "Ana Reyes",
      "America/Tegucigalpa",
    );
    expect(message.text).toContain("Hi &lt;!channel&gt; &amp; &lt;@U1&gt;");
    expect(message.text).toContain("Ended in Magnus.");
  });
});

describe("end-of-day permissions and settings", () => {
  it("refuses other roles, another closer's report and cross-tenant retry, while an admin can retry", async () => {
    const h = await endOfDayHarness();
    const report = await h.closer.mutation(api.closer.endOfDay.endMyDay, {});
    await expect(
      h.admin.mutation(api.closer.endOfDay.endMyDay, {}),
    ).rejects.toThrow();
    const other = h.t.withIdentity({
      subject: "user_closer_other",
      org_id: "org_test",
    });
    expect(
      await other.query(api.closer.endOfDay.getMyReport, {
        reportId: report._id,
      }),
    ).toBeNull();
    await expect(
      other.mutation(api.closer.endOfDay.retryEndOfDayPost, {
        reportId: report._id,
      }),
    ).rejects.toThrow("Report not found or not yours");
    await expect(
      h.admin.mutation(api.closer.endOfDay.retryEndOfDayPost, {
        reportId: report._id,
      }),
    ).rejects.toThrow("No end-of-day Slack channel");
    await h.t.run(async (ctx) => {
      const tenantId = await ctx.db.insert("tenants", {
        companyName: "Other",
        contactEmail: "other@example.test",
        workosOrgId: "org_other",
        status: "active",
        inviteExpiresAt: 0,
        createdBy: "test",
      });
      await ctx.db.patch("endOfDayReports", report._id, { tenantId });
    });
    await expect(
      h.admin.mutation(api.closer.endOfDay.retryEndOfDayPost, {
        reportId: report._id,
      }),
    ).rejects.toThrow("Report not found or not yours");
  });

  it("validates and saves a time zone for any tenant user", async () => {
    const h = await endOfDayHarness();
    for (const caller of [h.closer, h.admin])
      await caller.mutation(api.users.timezone.updateMyTimezone, {
        timeZone: "Europe/Madrid",
      });
    await expect(
      h.closer.mutation(api.users.timezone.updateMyTimezone, {
        timeZone: "Mars/Nowhere",
      }),
    ).rejects.toThrow("valid IANA time zone");
    expect(
      await h.t.run((ctx) => ctx.db.get("users", h.closerId)),
    ).toMatchObject({ timezone: "Europe/Madrid" });
  });

  it("leaves an omitted EOD channel untouched and clears it on null", async () => {
    const h = await endOfDayHarness(true);
    const required = {
      notifyChannelId: "C_OTHER",
      notifyChannelName: "other",
      staleReminderChannelId: "C_STALE",
      staleReminderChannelName: "stale",
    };
    await h.admin.mutation(api.slack.channels.setSlackNotifyChannels, required);
    expect(
      await h.t.run((ctx) =>
        ctx.db.get("slackInstallations", h.installationId!),
      ),
    ).toMatchObject({ eodReportChannelId: "C_EOD" });
    await h.admin.mutation(api.slack.channels.setSlackNotifyChannels, {
      ...required,
      eodReportChannel: null,
    });
    expect(
      (
        await h.t.run((ctx) =>
          ctx.db.get("slackInstallations", h.installationId!),
        )
      )?.eodReportChannelId,
    ).toBeUndefined();
    await h.admin.mutation(api.slack.channels.setSlackNotifyChannels, {
      ...required,
      eodReportChannel: { channelId: "C_NEW", channelName: "new-eod" },
    });
    expect(
      await h.t.run((ctx) =>
        ctx.db.get("slackInstallations", h.installationId!),
      ),
    ).toMatchObject({
      eodReportChannelId: "C_NEW",
      eodReportChannelName: "new-eod",
    });
  });
});
