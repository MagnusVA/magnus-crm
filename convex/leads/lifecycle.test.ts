import { describe, expect, test } from "vitest";
import {
  advanceLifecycle,
  combineLifecycles,
  deriveLifecycle,
} from "./lifecycle";

const OCT_1 = Date.UTC(2026, 9, 1, 12);
const OCT_3 = Date.UTC(2026, 9, 3, 12);
const OCT_5 = Date.UTC(2026, 9, 5, 12);
const OCT_9 = Date.UTC(2026, 9, 9, 12);

describe("advanceLifecycle", () => {
  test("a person who books straight from a DM link reaches every earlier stage at the booking", () => {
    expect(advanceLifecycle(null, "booked", OCT_3)).toEqual({
      stage: "booked",
      enteredAt: {
        prospect: OCT_3,
        in_conversation: OCT_3,
        qualified: OCT_3,
        booked: OCT_3,
      },
    });
  });

  test("a qualified person who books later keeps their qualification time", () => {
    const qualified = advanceLifecycle(null, "qualified", OCT_1);
    expect(advanceLifecycle(qualified, "booked", OCT_5)).toEqual({
      stage: "booked",
      enteredAt: {
        prospect: OCT_1,
        in_conversation: OCT_1,
        qualified: OCT_1,
        booked: OCT_5,
      },
    });
  });

  test("a late event at a lower stage moves entry times earlier but never the stage back", () => {
    const customer = {
      stage: "customer" as const,
      enteredAt: {
        prospect: OCT_5,
        in_conversation: OCT_5,
        qualified: OCT_5,
        booked: OCT_5,
        showed: OCT_9,
        customer: OCT_9,
      },
    };
    expect(advanceLifecycle(customer, "qualified", OCT_3)).toEqual({
      stage: "customer",
      enteredAt: {
        prospect: OCT_3,
        in_conversation: OCT_3,
        qualified: OCT_3,
        booked: OCT_5,
        showed: OCT_9,
        customer: OCT_9,
      },
    });
  });

  test("a later event at a lower stage changes nothing", () => {
    const showed = advanceLifecycle(null, "showed", OCT_3);
    expect(advanceLifecycle(showed, "booked", OCT_9)).toEqual(showed);
  });
});

describe("deriveLifecycle", () => {
  test("no evidence means no lifecycle", () => {
    expect(deriveLifecycle([])).toBeNull();
  });

  test("a capture before the qualification sets an earlier Prospect time", () => {
    expect(
      deriveLifecycle([
        { stage: "qualified", at: OCT_3 },
        { stage: "prospect", at: OCT_1 },
      ]),
    ).toEqual({
      stage: "qualified",
      enteredAt: {
        prospect: OCT_1,
        in_conversation: OCT_3,
        qualified: OCT_3,
      },
    });
  });

  test("the order of the evidence does not matter", () => {
    const evidence = [
      { stage: "customer" as const, at: OCT_9 },
      { stage: "booked" as const, at: OCT_3 },
      { stage: "qualified" as const, at: OCT_1 },
      { stage: "showed" as const, at: OCT_5 },
    ];
    expect(deriveLifecycle(evidence)).toEqual(
      deriveLifecycle([...evidence].reverse()),
    );
    expect(deriveLifecycle(evidence)).toEqual({
      stage: "customer",
      enteredAt: {
        prospect: OCT_1,
        in_conversation: OCT_1,
        qualified: OCT_1,
        booked: OCT_3,
        showed: OCT_5,
        customer: OCT_9,
      },
    });
  });
});

describe("combineLifecycles", () => {
  test("a merge keeps the higher stage and the earlier time for each stage", () => {
    const target = deriveLifecycle([{ stage: "booked", at: OCT_5 }]);
    const source = deriveLifecycle([
      { stage: "qualified", at: OCT_1 },
      { stage: "showed", at: OCT_9 },
    ]);
    expect(combineLifecycles(target, source)).toEqual({
      stage: "showed",
      enteredAt: {
        prospect: OCT_1,
        in_conversation: OCT_1,
        qualified: OCT_1,
        booked: OCT_5,
        showed: OCT_9,
      },
    });
  });

  test("merging with a person who has no lifecycle keeps the other one", () => {
    const target = deriveLifecycle([{ stage: "booked", at: OCT_5 }]);
    expect(combineLifecycles(target, null)).toEqual(target);
    expect(combineLifecycles(null, target)).toEqual(target);
  });
});
