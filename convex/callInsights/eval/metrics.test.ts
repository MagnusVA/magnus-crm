import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { BAR_DEFINITIONS, computeMetrics, type MetricCase } from "./metrics";

type Label = MetricCase["labels"][number];
const label = (id: string, patch: Partial<Label> = {}): Label => ({
  _id: id as Id<"callInsightEvalLabels">,
  source: "extractor",
  itemClass: "income",
  adminVerdict: "right",
  ...patch,
});
function fixture(key: string, i: number, bad = false): MetricCase {
  const c: MetricCase = {
    case: {
      _id: `c${i}` as Id<"callInsightEvalCases">,
      createdAt: i,
      groupKey: `p${i}`,
      status: "labels_committed",
      listCommittedAt: 1,
    },
    labels: [],
  };
  const s = label(`s${i}`, {
    itemClass: "result",
    resultKind: "paid",
    resultTier: "ready",
    resultValues: {
      amountMinor: 10000,
      currency: "USD",
      currencyAssumed: false,
    },
  });
  const a = label(`a${i}`, {
    source: "admin",
    itemClass: "result",
    resultKind: "paid",
    resultValues: {
      amountMinor: 10000,
      currency: "USD",
      currencyAssumed: false,
    },
  });
  const att = label(`att${i}`, {
    itemClass: "attendance",
    noShowTier: "review",
  });
  const ownAtt = label(`ownatt${i}`, {
    source: "admin",
    itemClass: "attendance",
    category: "no_show",
  });
  if (["invented_income", "income_right"].includes(key))
    c.labels = [0, 1].map((j) =>
      label(`e${i}:${j}`, {
        adminVerdict: bad ? "wrong" : "right",
        wrongFields: bad ? ["exists"] : [],
      }),
    );
  else if (["objection_precision", "resolution_right"].includes(key))
    c.labels = [0, 1, 2].map((j) =>
      label(`e${i}:${j}`, {
        itemClass: "objection",
        resolution: "resolved",
        adminVerdict: bad ? "wrong" : "right",
        wrongFields: bad ? ["resolution"] : [],
      }),
    );
  else if (["objection_recall", "recall_lost_jev"].includes(key)) {
    c.labels = [0, 1].flatMap((j) => [
      label(`e${i}:${j}`, {
        itemClass: "objection",
        itemKey: `objection:${j}`,
      }),
      label(`a${i}:${j}`, {
        source: "admin",
        itemClass: "objection",
        matchedLabelId:
          bad && key === "objection_recall"
            ? undefined
            : (`e${i}:${j}` as Id<"callInsightEvalLabels">),
      }),
    ]);
    c.items = [0, 1].map((j) => ({
      key: `objection:${j}`,
      check: bad && key === "recall_lost_jev" ? "rejected" : "confirmed",
    }));
  } else if (
    key.startsWith("no_show") ||
    ["wrong_review", "hard_held_certain", "wrong_certain"].includes(key)
  ) {
    c.labels = [att, ownAtt];
    if (key === "wrong_review" && bad) ownAtt.category = "held";
    if (key === "no_show_coverage") {
      c.recordedKind = "no_show";
      att.noShowTier = bad ? "unconfirmed" : "certain";
    }
    if (key === "no_show_check") att.noShowTier = bad ? "check" : "review";
    if (key === "hard_held_certain") {
      ownAtt.category = "held";
      c.hardCaseHeld = true;
      att.noShowTier = bad ? "certain" : "check";
    }
    if (key === "wrong_certain") {
      att.noShowTier = "certain";
      ownAtt.category = bad ? "held" : "no_show";
    }
  } else {
    c.labels = [s, a];
    if (key === "callback_date") {
      s.resultKind = a.resultKind = "call_back";
      s.resultValues = { callbackAt: bad ? 2 : 1 };
      a.resultValues = { callbackAt: 1 };
    }
    if (key === "loss_category") {
      s.resultKind = a.resultKind = "lost";
      s.resultValues = { lossCategory: bad ? "timing" : "price" };
      a.resultValues = { lossCategory: "price" };
    }
    if (key === "promise_as_paid") {
      a.resultKind = "promised";
      s.resultKind = bad ? "paid" : "promised";
      if (bad) {
        s.adminVerdict = "wrong";
        s.wrongFields = ["resultKind"];
      }
    }
    if (key === "usd_assumed") {
      s.resultValues!.currencyAssumed = true;
      a.resultValues!.currencyAssumed = true;
    }
    if (key === "actionable_coverage" && bad) s.resultTier = "check";
    if (key === "amount_carried" && bad) delete s.resultValues!.amountMinor;
    if (
      [
        "right_result",
        "named_currency",
        "usd_assumed",
        "amount_prefill",
      ].includes(key) &&
      bad
    ) {
      s.adminVerdict = "wrong";
      s.wrongFields = [
        key === "right_result"
          ? "resultKind"
          : key === "amount_prefill"
            ? "amountMinor"
            : "currency",
      ];
      if (key === "named_currency" || key === "usd_assumed")
        s.wrongFields.push("currencyAssumed");
    }
  }
  return c;
}
const bar = (key: string, cases: MetricCase[]) =>
  computeMetrics(cases).find((b) => b.key === key)!;

describe("every fixed-sample bar", () => {
  for (const d of BAR_DEFINITIONS) {
    const perCall = [
      "invented_income",
      "income_right",
      "objection_recall",
      "recall_lost_jev",
    ].includes(d.key)
      ? 2
      : ["objection_precision", "resolution_right"].includes(d.key)
        ? 3
        : 1;
    const floor = Math.max(d.callFloor, Math.ceil(d.floor / perCall));
    it(`${d.key}: below, at and above the floor`, () => {
      const sample = Array.from({ length: floor }, (_, i) => fixture(d.key, i));
      expect(bar(d.key, sample.slice(0, -1)).result).toBe("inconclusive");
      expect(bar(d.key, sample).result).toBe("pass");
      const result = bar(d.key, [...sample, fixture(d.key, floor, true)]);
      expect(result.result).toBe("pass");
      expect(result.calls).toBe(floor);
      expect(result.lowerBound).toBeGreaterThan(0);
    });
    it(`${d.key}: passes at the error rule and fails above it`, () => {
      const allowed =
        d.callRate !== undefined
          ? Math.floor((1 - d.callRate) * floor + 1e-8)
          : d.maxCallLoss !== undefined
            ? Math.floor(d.maxCallLoss * floor)
            : d.minRight !== undefined
              ? floor - d.minRight
              : d.maxWrong!;
      const sample = Array.from({ length: floor }, (_, i) =>
        fixture(d.key, i, i < allowed),
      );
      expect(bar(d.key, sample).result).toBe("pass");
      expect(
        bar(
          d.key,
          sample.map((c, i) => (i === allowed ? fixture(d.key, i, true) : c)),
        ).result,
      ).toBe("fail");
    });
  }
  it("enforces the distinct-call floor even with many items", () => {
    const c = fixture("income_right", 0);
    c.labels = Array.from({ length: 30 }, (_, i) => label(`e${i}`));
    expect(bar("income_right", [c])).toMatchObject({
      n: 30,
      calls: 1,
      result: "inconclusive",
    });
  });
  it("counts one person once, committed labels only, and does not mutate input order", () => {
    const sample = Array.from({ length: 10 }, (_, i) =>
      fixture("income_right", i),
    );
    const original = [...sample].reverse();
    const uncommitted = fixture("income_right", 99);
    uncommitted.case.status = "list_committed";
    const duplicate = fixture("income_right", 100);
    duplicate.case.groupKey = "p0";
    expect(
      bar("income_right", [...original, duplicate, uncommitted]),
    ).toMatchObject({ n: 20, calls: 10, result: "pass" });
    expect(original[0].case.createdAt).toBe(9);
  });
  it("treats unsure critical labels as blocking and an empty wrongFields as invented income", () => {
    const sample = Array.from({ length: 10 }, (_, i) =>
      fixture("invented_income", i),
    );
    sample[0].labels[0].adminVerdict = "unsure";
    expect(bar("invented_income", sample).result).toBe("fail");
    sample[0].labels[0].adminVerdict = "wrong";
    sample[0].labels[0].wrongFields = [];
    expect(bar("invented_income", sample)).toMatchObject({
      wrong: 1,
      result: "fail",
    });
    sample[0].labels[0].wrongFields = ["period"];
    expect(bar("invented_income", sample)).toMatchObject({
      wrong: 0,
      result: "pass",
    });
  });
  it("excludes skipped lists and counts Jev-rejected matches as recall misses", () => {
    const skipped = fixture("objection_recall", 0);
    skipped.labels = skipped.labels.filter((l) => l.source !== "admin");
    expect(bar("objection_recall", [skipped]).n).toBe(0);
    const rejected = fixture("recall_lost_jev", 0, true);
    expect(bar("objection_recall", [rejected])).toMatchObject({
      n: 2,
      wrong: 2,
    });
    expect(bar("recall_lost_jev", [rejected])).toMatchObject({
      n: 2,
      wrong: 2,
    });
  });
  it("uses call-level outcomes even when most items are right", () => {
    const sample = Array.from({ length: 15 }, (_, i) =>
      fixture("objection_precision", i),
    );
    for (const c of sample.slice(0, 2)) c.labels[0].adminVerdict = "wrong";
    expect(bar("objection_precision", sample)).toMatchObject({
      n: 45,
      wrong: 2,
      calls: 15,
      result: "fail",
    });
  });
  it("grades result kind separately from amount and currency", () => {
    const sample = Array.from({ length: 60 }, (_, i) =>
      fixture("right_result", i),
    );
    for (const c of sample) {
      c.labels[0].adminVerdict = "wrong";
      c.labels[0].wrongFields = ["amountMinor"];
    }
    expect(bar("right_result", sample).result).toBe("pass");
    expect(bar("amount_prefill", sample).result).toBe("fail");
  });
});

describe("money bars read the admin's grade, not the admin's typed result", () => {
  const sample = (key: string, edit: (c: MetricCase) => void) =>
    Array.from({ length: 30 }, (_, i) => {
      const c = fixture(key, i);
      edit(c);
      return c;
    });
  const suggestion = (c: MetricCase) => c.labels[0];
  const typed = (c: MetricCase) => c.labels[1];

  it("an assumed USD graded Right is right even when the typed result has no assumption", () => {
    const cases = sample("usd_assumed", (c) => {
      suggestion(c).resultValues = {
        amountMinor: 170000,
        currency: "USD",
        currencyAssumed: true,
      };
      typed(c).resultValues = { amountMinor: 160000, currency: "EUR" };
    });
    expect(bar("usd_assumed", cases)).toMatchObject({
      wrong: 0,
      result: "pass",
    });
    expect(bar("named_currency", cases).n).toBe(0);
  });
  it("an assumed USD counts wrong only when its currency is ticked wrong", () => {
    const cases = sample("usd_assumed", () => {});
    suggestion(cases[0]).adminVerdict = "wrong";
    suggestion(cases[0]).wrongFields = ["amountMinor"];
    expect(bar("usd_assumed", cases)).toMatchObject({
      wrong: 0,
      result: "pass",
    });
    expect(bar("amount_prefill", cases)).toMatchObject({
      wrong: 1,
      result: "fail",
    });
    suggestion(cases[0]).wrongFields = ["currency", "currencyAssumed"];
    expect(bar("usd_assumed", cases)).toMatchObject({
      wrong: 1,
      result: "fail",
    });
    expect(bar("amount_prefill", cases)).toMatchObject({
      wrong: 0,
      result: "pass",
    });
  });
  it("a whole-item Wrong counts the currency and amount wrong", () => {
    const cases = sample("usd_assumed", () => {});
    suggestion(cases[0]).adminVerdict = "wrong";
    suggestion(cases[0]).wrongFields = [];
    expect(bar("usd_assumed", cases).wrong).toBe(1);
    expect(bar("amount_prefill", cases).wrong).toBe(1);
  });
  it("a named currency and an amount graded Right are right whatever was typed", () => {
    const cases = sample("named_currency", (c) => {
      typed(c).resultValues = { amountMinor: 1, currency: "GBP" };
    });
    expect(bar("named_currency", cases)).toMatchObject({
      wrong: 0,
      result: "pass",
    });
    expect(bar("amount_prefill", cases)).toMatchObject({
      wrong: 0,
      result: "pass",
    });
  });
  it("a paid suggestion graded Right is not a promise, even if the typed result says promised", () => {
    const cases = sample("promise_as_paid", (c) => {
      suggestion(c).resultKind = "paid";
    });
    expect(bar("promise_as_paid", cases).n).toBe(0);
    suggestion(cases[0]).adminVerdict = "wrong";
    suggestion(cases[0]).wrongFields = ["resultKind"];
    expect(bar("promise_as_paid", cases)).toMatchObject({ n: 1, wrong: 1 });
  });
  it("a promised suggestion graded Right counts as a promise whatever was typed", () => {
    const cases = sample("promise_as_paid", (c) => {
      typed(c).resultKind = "paid";
    });
    expect(bar("promise_as_paid", cases)).toMatchObject({ wrong: 0 });
    expect(bar("promise_as_paid", cases).n).toBeGreaterThan(0);
  });
});
