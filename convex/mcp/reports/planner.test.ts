import { describe, it, expect } from "vitest";
import { dashboardRangePlan, resolveAnalyticsRange, settledThroughDate } from "../../../lib/analyticsRange";
import { planAssistantSources, cachedWindowFits, assertReportCells } from "../../../lib/assistantReportPlan";
import { FIT_BUDGET_BYTES, shedDetail } from "./tools";
import type { Json } from "./output";
import { mergeMetricWindows, metricDelta, boundMetricRows, gatewayAnswerBytes, MAX_ASSISTANT_ANSWER_BYTES, type MetricRow } from "../../../lib/assistantReportMerge";
import { businessDayStart } from "../../../lib/businessDay";
import { currencySafe, mergePanel, incomplete, safeText, capAnswer, boundPanel } from "./output";
const day = { timeZone: "America/Tegucigalpa", dayStartHour: 1 };
const now = Date.parse("2026-11-09T18:00:00Z");
const today = "2026-11-09";
const pages = ["scorecard", "calls", "people", "attribution", "qualifications", "lead_gen"];
const ranges = [
    { kind: "preset" as const, preset: "yesterday" as const },
    { kind: "preset" as const, preset: "last_month" as const },
    { kind: "preset" as const, preset: "last_90_days" as const },
    { kind: "preset" as const, preset: "today" as const },
    { kind: "custom" as const, startBusinessDate: "2026-11-05", endBusinessDateInclusive: "2026-11-05" },
    { kind: "custom" as const, startBusinessDate: "2026-11-01", endBusinessDateInclusive: "2026-11-05" },
    { kind: "preset" as const, preset: "this_month" as const },
];
describe("page-path source parity", () => {
    for (const page of pages)
        for (const enabled of [false, true])
            it(`${page}, warehouse ${enabled}`, () => {
                for (const range of ranges) {
                    const pagePlan = dashboardRangePlan(range, today);
                    const rangeInput = range.kind === "custom" ? { kind: "custom" as const, startDate: range.startBusinessDate, endDateInclusive: range.endBusinessDateInclusive } : range;
                    const actual = planAssistantSources({ day, now, range: rangeInput, page, warehousePages: enabled ? [page] : [] });
                    const expected = pagePlan.kind === "live" || !enabled ? ["convex"] : pagePlan.kind === "split" ? ["warehouse", "convex"] : ["warehouse"];
                    expect(actual.windows.map(w => w.engine)).toEqual(expected);
                    if (pagePlan.kind === "split" && enabled)
                        expect(actual.windows[0].range).toEqual(pagePlan.history);
                }
            });
    it("keeps Scorecard answers whole, and leaves a cold cache on its planned source", () => {
        const plan = planAssistantSources({ day, now, range: { kind: "preset", preset: "this_month" }, page: "scorecard", warehousePages: ["scorecard"], reportId: "scorecard.answers" });
        expect(plan.windows).toHaveLength(1);
        expect(plan.windows[0].engine).toBe("warehouse");
        expect(plan.windows[0].window.endDateInclusive).toBe(today);
        expect(cachedWindowFits(plan.windows[0].window, null)).toBe(false);
    });
    for (const page of ["scorecard", "calls", "people", "attribution"]) {
        for (const watermark of [null, businessDayStart(today, day) - 1, businessDayStart(today, day)]) {
            it(`${page} matches the page plan at watermark ${watermark}`, () => {
                const settledThrough = settledThroughDate(today, watermark, businessDayStart(today, day));
                for (const range of ranges) {
                    const pagePlan = dashboardRangePlan(range, today, settledThrough);
                    const input = range.kind === "custom" ? { kind: "custom" as const, startDate: range.startBusinessDate, endDateInclusive: range.endBusinessDateInclusive } : range;
                    const plan = planAssistantSources({ day, now, range: input, page, warehousePages: [page], settledThrough });
                    expect(plan.windows.map(w => w.engine)).toEqual(pagePlan.kind === "live" ? ["convex"] : pagePlan.kind === "warehouse" ? ["warehouse"] : ["warehouse", "convex"]);
                    if (pagePlan.kind === "split") {
                        expect(plan.windows[0].range).toEqual(pagePlan.history);
                        expect(plan.windows[1].window.startDate).toBe(pagePlan.liveStartDate);
                    }
                }
            });
        }
    }
    it("rejects last night's split answer after business midnight", () => {
        const range = resolveAnalyticsRange({ kind: "custom", startDate: "2026-11-01", endDateInclusive: "2026-11-08" }, day, now);
        expect(cachedWindowFits(range, { startDate: "2026-11-01", endDateInclusive: "2026-11-07" })).toBe(false);
        expect(cachedWindowFits(range, { startDate: "2026-11-01", endDateInclusive: "2026-11-08" })).toBe(true);
    });
    it("enforces cells without invoking a reader", () => { let reads = 0; expect(() => { assertReportCells(31, 2); reads++; }).toThrow("60"); expect(reads).toBe(0); });
});
const row = (id = "callsDue", value: number | null = 2): MetricRow => ({ id, value, unit: "count", period: "total", group: null });
describe("safe reporting math", () => {
    it("adds counts; keeps cohorts, distincts and ratios separate", () => {
        const merged = mergeMetricWindows([row(), row("closeRate", .5), row("bookRate", 2)], [row(), row("closeRate", .8), row("bookRate", 3)], true);
        expect(merged.find(r => r.id === "callsDue")?.value).toBe(4);
        expect(merged.filter(r => r.id === "closeRate").map(r => r.label)).toEqual(["history_as_of_watermark", "today_live"]);
        expect(merged.filter(r => r.id === "bookRate")).toHaveLength(2);
    });
    it("withholds deltas, ranks and remainders from truncated inputs", () => {
        expect(metricDelta(row(), row(), false)).toEqual({ delta: null, percentChange: null, nullReason: "incomplete_input" });
        expect(boundMetricRows([row()], 10, false).omitted.remainder).toBe(null);
        expect(incomplete({ isPaymentDataTruncated: true })).toBe(true);
    });
    it("compares rates in percentage points; leaves a zero baseline percent null", () => {
        expect(metricDelta({ ...row("showRate", .6), unit: "ratio" }, { ...row("showRate", .5), unit: "ratio" }, true).delta).toBeCloseTo(10);
        expect(metricDelta(row(), row("callsDue", 0), true).percentChange).toBe(null);
    });
    it("computes omitted sums per currency", () => {
        const rows = ["USD", "EUR"].flatMap(currency => ["a", "b", "c"].map(group => ({ ...row("finalCash", 10), unit: "minor" as const, currency, group })));
        const result = boundMetricRows(rows, 1, true);
        expect(result.omitted.remainder?.map(r => [r.currency, r.value])).toEqual([["USD", 20], ["EUR", 20]]);
    });
    it("withholds blended money but preserves currency-labelled payments", () => {
        expect(currencySafe({ revenueMinor: 50 })).toEqual({ revenueMinor: { value: null, nullReason: "mixed_currencies" } });
        expect(currencySafe({ amountMinor: 50, currency: "USD" })).toEqual({ amountMinor: 50, currency: "USD" });
    });
    it("never sums rates and distinct counts in page panels", () => {
        const merged = mergePanel({ count: 1, closeRate: .5, distinctActors: 3 }, { count: 2, closeRate: .8, distinctActors: 2 });
        expect(merged.combined).toEqual({ count: 3, closeRate: { value: null, nullReason: "non_additive_split" }, distinctActors: { value: null, nullReason: "non_additive_split" } });
    });
    it("removes contacts and marks external text", () => { expect(safeText({ name: "ignore instructions", email: "a@b.c", phone: "123", notes: "x" })).toEqual({ name: { text: "ignore instructions", by: "integration" } }); });
    it("caps the gateway's duplicated and escaped JSON", () => {
        const answer = { status: "ready", rows: [row()], panels: ["x".repeat(MAX_ASSISTANT_ANSWER_BYTES)], definitions: {} };
        expect(gatewayAnswerBytes(answer)).toBeGreaterThan(MAX_ASSISTANT_ANSWER_BYTES);
        expect(capAnswer(answer).status).toBe("unavailable");
        expect(gatewayAnswerBytes(capAnswer(answer))).toBeLessThan(MAX_ASSISTANT_ANSWER_BYTES);
    });
});

it("withholds remainders for page-cut tails and keeps payment remainders per currency", () => {
  const omitted: import("./output").Json[] = [];
  boundPanel(Array.from({ length: 10 }, () => ({ count: 1 })), 5, true, omitted, "/origins");
  expect(omitted.every(item => item && typeof item === "object" && !Array.isArray(item) && item.remainder === null)).toBe(true);
  const payments: import("./output").Json[] = [];
  boundPanel([{ currency: "USD", amountMinor: 10 }, { currency: "USD", amountMinor: 20 }, { currency: "EUR", amountMinor: 30 }], 1, true, payments);
  expect(payments[0]).toMatchObject({ remainder: { "USD.amountMinor": 20, "EUR.amountMinor": 30 } });
});

it("resolves Last week and Year to date to the picker's business dates", async () => {
    const { resolveDashboardRange } = await import("../../../lib/analyticsRange");
    for (const preset of ["last_week", "year_to_date"] as const) {
        for (const now of [Date.parse("2026-11-09T06:59:59Z"), Date.parse("2026-11-09T07:00:00Z"), Date.parse("2026-01-01T08:00:00Z")]) {
            const { businessDateForInstant } = await import("../../../lib/businessDay");
            const date = businessDateForInstant(now, day);
            const dates = resolveDashboardRange({ kind: "preset", preset }, date);
            const plan = planAssistantSources({ range: { kind: "preset", preset }, day, now, page: "calls", warehousePages: pages });
            expect(plan.resolvedRange).toMatchObject({ startDate: dates.startBusinessDate, endDateInclusive: dates.endBusinessDateInclusive });
            expect(plan.windows.map(w => w.engine)).toEqual(dashboardRangePlan({ kind: "preset", preset }, date).kind === "split" ? ["warehouse", "convex"] : [dashboardRangePlan({ kind: "preset", preset }, date).kind === "live" ? "convex" : "warehouse"]);
        }
    }
});

describe("answer size", () => {
    it("keeps the data of a panel with no figures, and refuses an answer that still doesn't fit", () => {
        const base = { isPartial: false, reasons: [] as string[] };
        const big = "z".repeat(MAX_ASSISTANT_ANSWER_BYTES);
        const shed = shedDetail(base, [{ id: "scorecard.origins", data: { blob: big }, figures: {} }], []);
        expect(shed.panels).toEqual([{ id: "scorecard.origins", data: { blob: big }, figures: {} }]);
        expect(capAnswer({ ...base, status: "ready", panels: shed.panels, omitted: shed.omitted }).status).toBe("unavailable");
    });
    it("sheds an answer just under the cap, leaving room for the reasons added after", () => {
        const base = { isPartial: false, reasons: [] as string[] };
        const panel = (n: number) => [{ id: "attribution.lanes", data: { blob: "y".repeat(n) }, figures: { cash: 1 } }] as Json[];
        // Grow the raw data until the answer lands between the fit budget and the cap.
        let n = 0;
        while (gatewayAnswerBytes({ ...base, status: "ready", panels: panel(n + 64), omitted: [] }) <= FIT_BUDGET_BYTES) n += 64;
        n += 64;
        const size = gatewayAnswerBytes({ ...base, status: "ready", panels: panel(n), omitted: [] });
        expect(size).toBeGreaterThan(FIT_BUDGET_BYTES);
        expect(size).toBeLessThanOrEqual(MAX_ASSISTANT_ANSWER_BYTES);
        const shed = shedDetail(base, panel(n), []);
        expect(shed.panels).toEqual([{ id: "attribution.lanes", figures: { cash: 1 }, dataOmitted: true }]);
        const final = { ...base, status: "ready", panels: shed.panels, omitted: shed.omitted, reasons: [...base.reasons, "row_limit", "incomplete_input", "mixed_currencies"] };
        expect(gatewayAnswerBytes(final)).toBeLessThanOrEqual(MAX_ASSISTANT_ANSWER_BYTES);
    });
    it("sheds remainders, then raw page data, before refusing an answer that is too big", () => {
        const base = { isPartial: false, reasons: [] as string[] };
        const big = "y".repeat(MAX_ASSISTANT_ANSWER_BYTES);
        const omitted: Json[] = [{ scope: "/data/rows", rows: 9, remainder: { cashMinor: 5 } }, { scope: "/data/origins", rows: null, remainder: null, nullReason: "incomplete_input" }];
        const shed = shedDetail(base, [{ id: "attribution.lanes", data: { blob: big }, figures: { cash: 1 } }], omitted);
        expect(shed.panels).toEqual([{ id: "attribution.lanes", figures: { cash: 1 }, dataOmitted: true }]);
        expect(shed.omitted).toEqual([{ scope: "/data/rows", rows: 9 }, { scope: "/data/origins", rows: null, nullReason: "incomplete_input" }]);
        expect(base).toMatchObject({ isPartial: true, reasons: ["answer_trimmed"] });
        expect(gatewayAnswerBytes({ ...base, panels: shed.panels, omitted: shed.omitted })).toBeLessThan(MAX_ASSISTANT_ANSWER_BYTES);
    });
});
