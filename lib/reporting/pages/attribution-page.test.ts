import { describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import type { AttributionLanes, AttributionPaths } from "@/convex/reports/attribution";
import {
  NOT_LINKED,
  buildAttributionDocument,
  formatCoverage,
  laneViews,
  pathLabel,
  pathRows,
  responsibleRows,
  shortDealId,
} from "@/app/workspace/reports/attribution/_components/attribution-shape";

// The Attribution page's shaping: lanes against Shared, coverage in words,
// every credited person, and the export document.

const person = (key: string, name: string, dealIds: string[], byCurrency: Array<{ currency: string; amountMinor: number }>, linked = true) => ({
  key,
  teamMemberId: linked ? (`tm_${key}` as Id<"teamMembers">) : null,
  teamId: null,
  name,
  linked,
  dealIds,
  byCurrency,
});

// Two USD payments: $60 on d1, credited to setters Ana and Bo, and $40 on
// d2, credited to Ana. A closer is on d1 only. One EUR payment, uncredited.
const lanes: AttributionLanes = {
  currencies: ["EUR", "USD"],
  totals: [
    { currency: "EUR", cashMinor: 5_000, finalMinor: 5_000, payments: 1 },
    { currency: "USD", cashMinor: 10_000, finalMinor: 10_000, payments: 2 },
  ],
  lanes: [
    // Out of chain order on purpose: the page puts them back.
    {
      role: "closer",
      byCurrency: [
        { currency: "EUR", laneMinor: 0, sharedMinor: 0, coverage: 0 },
        { currency: "USD", laneMinor: 6_000, sharedMinor: 0, coverage: 0.6 },
      ],
      dealIds: ["d1"],
      people: [person("cy", "Cy", ["d1"], [{ currency: "USD", amountMinor: 6_000 }])],
    },
    {
      role: "setter",
      byCurrency: [
        { currency: "EUR", laneMinor: 0, sharedMinor: 0, coverage: 0 },
        { currency: "USD", laneMinor: 10_000, sharedMinor: 6_000, coverage: 1 },
      ],
      dealIds: ["d1", "d2"],
      people: [
        person("bo", "Bo", ["d1"], [{ currency: "USD", amountMinor: 6_000 }], false),
        person("ana", "Ana", ["d1", "d2"], [{ currency: "USD", amountMinor: 10_000 }]),
      ],
    },
    {
      role: "lead_gen",
      byCurrency: [
        { currency: "EUR", laneMinor: 0, sharedMinor: 0, coverage: 0 },
        { currency: "USD", laneMinor: 0, sharedMinor: 0, coverage: 0 },
      ],
      dealIds: [],
      people: [],
    },
  ],
  uncreditedByRole: [
    { role: "closer", byCurrency: [{ currency: "EUR", amountMinor: 5_000 }, { currency: "USD", amountMinor: 4_000 }] },
    { role: "setter", byCurrency: [{ currency: "EUR", amountMinor: 5_000 }, { currency: "USD", amountMinor: 0 }] },
    { role: "lead_gen", byCurrency: [{ currency: "EUR", amountMinor: 5_000 }, { currency: "USD", amountMinor: 10_000 }] },
  ],
  isTruncated: false,
};

const paths: AttributionPaths = {
  paths: [
    { key: "setter", roles: ["setter"], dealIds: ["d2"], byCurrency: [{ currency: "USD", amountMinor: 4_000 }] },
    { key: "closer+setter", roles: ["setter", "closer"], dealIds: ["d1"], byCurrency: [{ currency: "USD", amountMinor: 6_000 }] },
    { key: "", roles: [], dealIds: ["d3"], byCurrency: [{ currency: "EUR", amountMinor: 5_000 }] },
  ],
  isTruncated: false,
};

describe("laneViews", () => {
  const views = laneViews(lanes, "USD");

  it("lists the lanes in chain order", () => {
    expect(views.map((view) => view.role)).toEqual(["lead_gen", "setter", "closer"]);
  });

  it("adds people's rows up to the lane plus Shared", () => {
    for (const view of views) expect(view.peopleMinor).toBe(view.laneMinor + view.sharedMinor);
    const setter = views[1];
    expect(setter).toMatchObject({ totalMinor: 10_000, laneMinor: 10_000, sharedMinor: 6_000, uncreditedMinor: 0, peopleMinor: 16_000 });
    expect(setter.people.map((row) => [row.name, row.amountMinor])).toEqual([
      ["Ana", 10_000],
      ["Bo", 6_000],
    ]);
  });

  it("makes every lane worth the range's cash: credited plus no credit in the role", () => {
    for (const view of views) expect(view.laneMinor + view.uncreditedMinor).toBe(view.totalMinor);
  });

  it("drops people with nothing in the shown currency", () => {
    expect(laneViews(lanes, "EUR").every((view) => view.people.length === 0)).toBe(true);
  });
});

describe("formatCoverage", () => {
  it("shows one decimal and a dash when there is no cash to cover", () => {
    expect(formatCoverage(0.338)).toBe("33.8%");
    expect(formatCoverage(1)).toBe("100%");
    expect(formatCoverage(0)).toBe("0%");
    expect(formatCoverage(null)).toBe("—");
    expect(formatCoverage(undefined)).toBe("—");
  });
});

describe("who is responsible and the paths", () => {
  it("ranks every credited person across roles by credited cash", () => {
    expect(responsibleRows(lanes, "USD").map((row) => [row.role, row.name, row.amountMinor])).toEqual([
      ["setter", "Ana", 10_000],
      ["setter", "Bo", 6_000],
      ["closer", "Cy", 6_000],
    ]);
  });

  it("names a path by its roles in chain order", () => {
    expect(pathLabel(["closer", "setter"])).toBe("Setter → Closer");
    expect(pathLabel([])).toBe("No credit in any role");
  });

  it("lists the paths that paid in one currency, most cash first", () => {
    expect(pathRows(paths, "USD").map((row) => [row.key, row.amountMinor])).toEqual([
      ["closer+setter", 6_000],
      ["setter", 4_000],
    ]);
    expect(pathRows(paths, "EUR").map((row) => row.key)).toEqual([""]);
  });

  it("names a deal by the end of its id", () => {
    expect(shortDealId("k17abcdef123456")).toBe("Deal …123456");
  });
});

describe("buildAttributionDocument", () => {
  const document = buildAttributionDocument({
    words: "This month · Nov 1 – Nov 8",
    dayLine: "Days run 1:00 am to 1:00 am, America/Tegucigalpa time",
    generatedAt: 0,
    lanes,
    paths,
  });

  it("summarizes cash and coverage per currency", () => {
    expect(document.summary).toContainEqual({ label: "Cash (USD)", value: "$100.00" });
    expect(document.summary).toContainEqual({ label: "Setter coverage (USD)", value: "100%" });
    expect(document.summary).toContainEqual({ label: "Closer coverage (USD)", value: "60%" });
    expect(document.summary).toContainEqual({ label: "Closer coverage (EUR)", value: "0%" });
  });

  it("says once that attribution is not commission", () => {
    expect(document.filters).toMatch(/never commission/u);
  });

  it("writes a row per person and currency, and says when a record has no member", () => {
    const table = document.tables.find((row) => row.title === "Who is responsible")!;
    expect(table.rows).toContainEqual({ role: "Setter", name: "Bo", member: NOT_LINKED, deals: 1, currency: "USD", credited: 6_000 });
    expect(document.tables.map((row) => row.title)).toEqual(["Cash by role", "Who is responsible", "Paths that paid", "Definitions"]);
  });

  it("keeps the lanes' Shared and uncredited cash per currency", () => {
    const table = document.tables.find((row) => row.title === "Cash by role")!;
    expect(table.rows).toContainEqual({
      role: "Setter",
      currency: "USD",
      total: 10_000,
      lane: 10_000,
      shared: 6_000,
      uncredited: 0,
      coverage: 1,
    });
  });
});
