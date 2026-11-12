import { describe, expect, it } from "vitest";
import {
  api,
  evalHarness,
  addCall,
  foreignAdmin,
} from "../../../tests/callInsights/synthetic/evalHarness";
import { waitFigures } from "./waitStudy";

describe("wait study", () => {
  it("uses exact bounds, fixed waits and counts unresolved arrivals as late", async () => {
    const f = await evalHarness({ status: "held" });
    const h = await f.t.run((ctx) =>
      ctx.db.get("callInsightFacts", f.headerId),
    );
    if (h?.kind !== "call") throw new Error("Missing fixture header");
    const headers = Array.from({ length: 59 }, () => h);
    expect(waitFigures(headers).waits.every((w) => w.pass)).toBe(true);
    expect(waitFigures(headers.slice(0, 58)).waits.every((w) => !w.pass)).toBe(
      true,
    );
    const late = { ...h, prospectFirstLineOffsetSeconds: 421 };
    expect(waitFigures([late]).waits.map((w) => w.late)).toEqual([1, 1, 0]);
    for (const patch of [
      { startOffsetSeconds: 1 },
      { endOffsetSeconds: 299 },
      { prospectIdentity: "fallback" as const },
      { prospectFirstLineOffsetSeconds: undefined },
    ]) {
      const figures = waitFigures([{ ...h, ...patch }]);
      expect(figures.waits[0]).toMatchObject({
        late: 1,
        unresolved: 1,
        pass: false,
      });
    }
    expect(
      waitFigures([{ ...h, startOffsetSeconds: 1 }]).leftCensoredShare,
    ).toBe(1);
    expect(waitFigures([]).waits[0]).toMatchObject({
      n: 0,
      upperBound: 1,
      pass: false,
    });
  });
  it("selects held calls since enabledAt, one per person, and lets admins settle and clear arrivals", async () => {
    const f = await evalHarness({ status: "held" });
    await f.t.run((ctx) =>
      ctx.db.patch("callInsightFacts", f.headerId, {
        startOffsetSeconds: 120,
        prospectIdentity: "unknown",
      }),
    );
    await addCall(f, 1, { samePerson: true });
    const call = await addCall(f, 2);
    await f.t.run(async (ctx) => {
      await ctx.db.patch("meetings", call.meetingId, { status: "scheduled" });
    });
    let view = await f.owner.query(api.wait.waitStudy, {});
    expect(view.waits[0]).toMatchObject({ n: 1, late: 1, unresolved: 1 });
    expect(view.unresolvedCalls).toHaveLength(1);
    await f.admin.mutation(api.wait.confirmArrival, {
      recordingId: f.recordingId,
      arrivedMinutesAfterStart: 2.5,
    });
    view = await f.owner.query(api.wait.waitStudy, {});
    expect(view.waits[0]).toMatchObject({ n: 1, late: 0, unresolved: 0 });
    expect(view.unresolvedCalls).toEqual([]);
    expect(
      await f.t.run((ctx) => ctx.db.get("callInsightFacts", f.headerId)),
    ).toMatchObject({
      confirmedArrivalOffsetSeconds: 150,
      prospectIdentity: "closer_confirmed",
    });
    await f.admin.mutation(api.wait.confirmArrival, {
      recordingId: f.recordingId,
      arrivedMinutesAfterStart: null,
    });
    expect(
      (await f.owner.query(api.wait.waitStudy, {})).waits[0].unresolved,
    ).toBe(1);
  });
  it("stops at the preset 59-person sample instead of extending a failed trial", async () => {
    const f = await evalHarness({ status: "held" });
    for (let i = 1; i <= 60; i++) await addCall(f, i);
    await f.t.run((ctx) =>
      ctx.db.patch("callInsightFacts", f.headerId, {
        confirmedArrivalOffsetSeconds: 700,
      }),
    );
    const view = await f.owner.query(api.wait.waitStudy, {});
    expect(view.waits[0]).toMatchObject({ n: 59, late: 1, pass: false });
  });
  it("enforces tenant and role access and validates finite offsets", async () => {
    const f = await evalHarness({ status: "held" });
    const other = await foreignAdmin(f);
    expect(
      (await other.query(api.wait.waitStudy, {})).waits.every((w) => w.n === 0),
    ).toBe(true);
    for (const caller of [f.closer, other])
      await expect(
        caller.mutation(api.wait.confirmArrival, {
          recordingId: f.recordingId,
          arrivedMinutesAfterStart: 2,
        }),
      ).rejects.toThrow();
    await expect(
      f.owner.mutation(api.wait.confirmArrival, {
        recordingId: f.recordingId,
        arrivedMinutesAfterStart: Infinity,
      }),
    ).rejects.toThrow();
  });
});
