import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import {
  callsReportFixture,
  from,
  identity,
  now,
  to,
} from "../../tests/callsReportFixtures";
import { peopleClosers } from "../analytics/definitions/people";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());
describe("People closers", () => {
  it("credits the first-held cohort to its historical closer and cash to the payment's closer", async () => {
    const f = await callsReportFixture();
    const answer = await f.t
      .withIdentity(identity)
      .query(api.reports.people.getPeopleClosers, {
        startDate: from,
        endDate: to,
      });
    const ana = answer.rows.find((r) => r.userId === f.ana)!;
    const beto = answer.rows.find((r) => r.userId === f.beto)!;
    expect(ana).toMatchObject({
      held: 1,
      noShow: 1,
      cohortDeals: 1,
      cohortWon: 1,
      dealsWon: 0,
      payments: 1,
    });
    expect(beto).toMatchObject({
      held: 2,
      cohortDeals: 0,
      dealsWon: 1,
      payments: 3,
    });
    expect(beto.cash).toEqual([
      { currency: "HNL", cashMinor: 30_000, finalMinor: 30_000 },
      { currency: "USD", cashMinor: 6_000, finalMinor: 4_000 },
    ]);
    expect(answer.unattributedCash).toEqual([
      { currency: "EUR", cashMinor: 10_000, finalMinor: 10_000 },
    ]);
    expect(answer.rows.find((r) => r.userId === f.former)).toMatchObject({
      cohortDeals: 1,
      cohortWon: 0,
      held: 1,
    });
    expect(answer.rows.find((r) => r.userId === f.inactive)).toMatchObject({
      isActive: false,
      held: 0,
    });
    expect(answer.calls).toEqual([]);
    expect(answer.partial).toBe(false);
  });
  it("forces a member's own row and refuses another member in both readers and filter parsing", async () => {
    const f = await callsReportFixture();
    const own = f.t.withIdentity({
      subject: "reports_ana",
      org_id: identity.org_id,
    });
    const answer = await own.query(api.reports.people.getPeopleClosers, {
      startDate: from,
      endDate: to,
    });
    expect(answer.rows.map((r) => r.userId)).toEqual([f.ana]);
    expect(answer.calls.map((c) => c.meetingId)).toEqual([
      f.hostChanged,
      f.noShow,
    ]);
    expect(answer.unattributedCash).toEqual([]);
    // A later payment remains visible on its linked historical call.
    expect(answer.calls[0].paidMinor).toEqual([
      { currency: "HNL", paidMinor: 30_000 },
      { currency: "USD", paidMinor: 6_000 },
    ]);
    await expect(
      own.query(api.reports.people.getPeopleClosers, {
        startDate: from,
        endDate: to,
        memberId: f.memberB,
      }),
    ).rejects.toThrow("only open your own");
    await f.t.run(async (ctx) => {
      const viewer = {
        tenantId: f.tenantId,
        userId: f.ana,
        role: "closer" as const,
        workosUserId: "reports_ana",
      };
      expect(await peopleClosers.parseFilters(ctx, {}, viewer)).toEqual({
        memberId: f.memberA,
      });
      await expect(
        peopleClosers.parseFilters(ctx, { memberId: f.memberB }, viewer),
      ).rejects.toThrow("only open your own");
    });
    const member = await f.t
      .withIdentity(identity)
      .query(api.reports.people.getPeopleClosers, {
        startDate: from,
        endDate: to,
        memberId: f.memberB,
      });
    expect(member.rows.map((r) => r.userId)).toEqual([f.beto]);
    expect(
      member.days
        .flatMap((d) => d.cashMinorByCurrency)
        .every((c) => c.currency === "USD" || c.currency === "HNL"),
    ).toBe(true);
  });
});
