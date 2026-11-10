import { describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import type { LogEntry } from "@/convex/reports/log";
import type { PipelineNow } from "@/convex/reports/pipeline";
import {
  buildPipelineDocument,
  countFigure,
  formatDays,
  nextStepWords,
  openDealCount,
  owedFigure,
  stagesProof,
} from "@/app/workspace/reports/pipeline/_components/pipeline-shape";
import { buildLogDocument, entityHref, personHref } from "@/app/workspace/reports/log/_components/log-shape";

// The Pipeline and Log pages' shaping: the band's figures (a count that
// couldn't be read is a dash, never zero), day words, record links and the
// export documents.

const pipeline: PipelineNow = {
  stages: [
    { stage: "qualified", count: 92, medianAgeDays: 9.24, oldestAgeDays: 41.7, partial: false },
    { stage: "booked", count: 64, medianAgeDays: 3.1, oldestAgeDays: 13, partial: false },
    { stage: "call_held", count: 41, medianAgeDays: null, oldestAgeDays: null, partial: false },
    { stage: "follow_up", count: 119, medianAgeDays: 21.7, oldestAgeDays: 96, partial: true },
  ],
  noNextStep: { count: 38, partial: false },
  overdueTasks: { count: 23, partial: true },
  owed: {
    total: 14,
    calls: [
      {
        meetingId: "m1" as Id<"meetings">,
        opportunityId: "o1" as Id<"opportunities">,
        scheduledAt: Date.parse("2026-10-29T16:00:00Z"),
        closerId: "u1" as Id<"users">,
        closerName: "Marco Reyes",
        leadName: "Avery Brooks",
        ageDays: 10,
      },
    ],
    partial: false,
  },
  bookingReviews: { count: 3, oldest: null, partial: false },
  aging: {
    deals: [
      {
        opportunityId: "o2" as Id<"opportunities">,
        leadName: "Kai Lindqvist",
        stage: "follow_up",
        ageDays: 96,
        closerName: null,
        nextStep: null,
      },
    ],
    partial: false,
  },
};

describe("the Pipeline band", () => {
  it("counts open deals and names the two biggest stages in stage order", () => {
    expect(openDealCount(pipeline)).toBe(316);
    expect(stagesProof(pipeline)).toBe("92 at Qualified · 119 at Follow-up");
    expect(stagesProof({ stages: pipeline.stages.map((stage) => ({ ...stage, count: 0 })) })).toBe("No open deals right now");
  });

  it("shows calls owed a result, a lower bound when partial, and a dash when the count couldn't be read", () => {
    expect(owedFigure({ total: 14, partial: false })).toEqual({ figure: "14", proof: "calls that owe a result" });
    expect(owedFigure({ total: 14, partial: true }).proof).toBe("at least this many calls owe a result");
    expect(owedFigure({ total: 0, partial: false }).proof).toBe("every past call has a result");
    const unread = owedFigure({ total: null, partial: true });
    expect(unread.figure).toBe("—");
    expect(unread.figure).not.toBe("0");
  });

  it("marks a count that is a lower bound", () => {
    expect(countFigure({ count: 23, partial: true })).toBe("23+");
    expect(countFigure({ count: 38, partial: false })).toBe("38");
  });

  it("words days, and a dash with nothing to measure", () => {
    expect(formatDays(9.24, 1)).toBe("9.2 days");
    expect(formatDays(1.4)).toBe("1 day");
    expect(formatDays(41.7)).toBe("41 days");
    expect(formatDays(null)).toBe("—");
  });

  it("words a deal's next step", () => {
    const date = () => "Nov 3";
    expect(nextStepWords({ kind: "call", at: 1 }, date)).toBe("Call Nov 3");
    expect(nextStepWords({ kind: "task", at: null }, date)).toBe("Task");
    expect(nextStepWords(null, date)).toBeNull();
  });

  it("exports the band, then stages, aging and the calls owed", () => {
    const document = buildPipelineDocument(pipeline, { generatedAt: 0, dayLine: "" });
    expect(document.summary).toEqual([
      { label: "Open deals", value: "316" },
      { label: "Not recorded", value: "14" },
      { label: "No next step", value: "38" },
      { label: "Overdue tasks", value: "23+" },
      { label: "Booking reviews", value: "3" },
    ]);
    expect(document.tables.map((table) => table.title)).toEqual(["Stages", "Aging", "Calls owed a result", "Definitions"]);
    expect(document.tables[1].rows[0]).toMatchObject({ person: "Kai Lindqvist", nextStep: "None", closer: null });
    const unread = buildPipelineDocument({ ...pipeline, owed: { ...pipeline.owed, total: null as unknown as number, partial: true } }, { generatedAt: 0, dayLine: "" });
    expect(unread.summary[1]).toEqual({ label: "Not recorded", value: "—" });
  });
});

const entry = (overrides: Partial<LogEntry>): LogEntry => ({
  _id: "e1" as Id<"domainEvents">,
  _creationTime: 0,
  tenantId: "t1" as Id<"tenants">,
  entityType: "meeting",
  entityId: "m1",
  eventType: "meeting.held",
  occurredAt: Date.parse("2026-10-31T22:41:00Z"),
  source: "closer",
  metadata: null,
  actorName: "Marco Reyes",
  label: "marked the call held",
  iconHint: "check",
  ...overrides,
});

describe("the Log", () => {
  it("opens a record when it has a page, and its person beside it", () => {
    expect(entityHref(entry({}))).toBe("/workspace/pipeline/meetings/m1");
    expect(entityHref(entry({ entityType: "opportunity", entityId: "o1" }))).toBe("/workspace/opportunities/o1");
    expect(entityHref(entry({ entityType: "lead", entityId: "l1" }))).toBe("/workspace/leads/l1");
    expect(entityHref(entry({ entityType: "payment", entityId: "p1" }))).toBeNull();
    expect(personHref(entry({ leadId: "l1" as Id<"leads"> }))).toBe("/workspace/leads/l1");
    expect(personHref(entry({ entityType: "lead", leadId: "l1" as Id<"leads"> }))).toBeNull();
  });

  it("exports the loaded rows and says when more were left unloaded", () => {
    const rows = [entry({ toStatus: "follow_up" }), entry({ _id: "e2" as Id<"domainEvents">, actorName: null })];
    const partial = buildLogDocument(rows, { words: "", dayLine: "", filters: "", generatedAt: 0, complete: false });
    expect(partial.summary).toEqual([{ label: "Events loaded", value: "2" }]);
    expect(partial.tables[0].rows).toEqual([
      { when: rows[0].occurredAt, who: "Marco Reyes", what: "Marked the call held", record: "Call", recordId: "m1", status: "Follow up" },
      { when: rows[1].occurredAt, who: "System", what: "Marked the call held", record: "Call", recordId: "m1", status: null },
    ]);
    expect(buildLogDocument(rows, { words: "", dayLine: "", filters: "", generatedAt: 0, complete: true }).tables[0].title).toBe("Events");
  });
});
