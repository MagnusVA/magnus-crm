import { describe, expect, it } from "vitest";
import { isReservedLossReason } from "../opportunities/stages";
import { assertTypedLossReason } from "../opportunities/reservedLossReason";
import type { Id } from "../_generated/dataModel";
import { lossReasonLabel, lossReasonText, maskReservedLossReason, refusalByline } from "./lossReasonLabel";

describe("lossReasonLabel", () => {
  it("labels system and reserved codes and passes typed text through", () => {
    expect(lossReasonLabel("no_show")).toBe("No-show");
    expect(lossReasonLabel("stale")).toBe("Slack qualification expired");
    expect(lossReasonLabel("payment_excluded")).toBe("Payment taken out");
    expect(lossReasonLabel("Budget")).toBe("Budget");
    expect(lossReasonLabel(undefined)).toBeNull();
    expect(lossReasonLabel("")).toBeNull();
  });

  it("never returns the reserved code as text, whatever its case or spacing", () => {
    for (const typed of ["payment_excluded", " Payment_Excluded ", "PAYMENT_EXCLUDED"]) {
      expect(isReservedLossReason(typed)).toBe(true);
      expect(lossReasonLabel(typed)).toBe("Payment taken out");
    }
  });
});

describe("assertTypedLossReason", () => {
  it("refuses a reserved code and accepts anything else", () => {
    expect(() => assertTypedLossReason(" Payment_Excluded")).toThrow();
    expect(() => assertTypedLossReason("payment excluded by mistake")).not.toThrow();
    expect(() => assertTypedLossReason("no_show")).not.toThrow();
    expect(() => assertTypedLossReason(undefined)).not.toThrow();
  });
});

const DEE = "user_dee" as Id<"users">;

describe("the call refusal code", () => {
  it.each(["call_refusal", "CALL_REFUSAL", " Call_Refusal "])("refuses %j as typed text", (typed) => {
    expect(isReservedLossReason(typed)).toBe(true);
    expect(() => assertTypedLossReason(typed)).toThrow("That reason is reserved");
  });

  it("accepts the same words written as a person would", () => {
    expect(() => assertTypedLossReason("call refusal")).not.toThrow();
    expect(() => assertTypedLossReason("Refused on the call")).not.toThrow();
  });

  it("labels the code and never returns it raw", () => {
    for (const stored of ["call_refusal", " Call_Refusal "]) {
      expect(lossReasonLabel(stored)).toBe("Refused on the call");
      expect(maskReservedLossReason(stored)).toBe("Refused on the call");
    }
  });
});

describe("refusalByline and lossReasonText", () => {
  it("names the person who confirmed a refusal", () => {
    const who = { lostByUserId: DEE, lostByName: "Dee" };
    expect(refusalByline("call_refusal", who)).toBe("confirmed by Dee");
    expect(lossReasonText("call_refusal", who)).toBe("Refused on the call · confirmed by Dee");
  });

  it("says a refusal with no person was recorded automatically", () => {
    for (const who of [{}, { lostByUserId: null, lostByName: "Dee" }]) {
      expect(refusalByline("call_refusal", who)).toBe("recorded automatically");
      expect(lossReasonText("call_refusal", who)).toBe("Refused on the call · recorded automatically");
    }
  });

  it("falls back to a fixed name when the person's name is missing", () => {
    expect(refusalByline("call_refusal", { lostByUserId: DEE, lostByName: "  " })).toBe("confirmed by a team member");
  });

  it("adds no byline to any other reason", () => {
    const who = { lostByUserId: DEE, lostByName: "Dee" };
    for (const [reason, label] of [
      ["no_show", "No-show"],
      ["payment_excluded", "Payment taken out"],
      ["Budget", "Budget"],
    ] as const) {
      expect(refusalByline(reason, who)).toBeNull();
      expect(lossReasonText(reason, who)).toBe(label);
      expect(lossReasonText(reason, {})).toBe(label);
    }
    expect(refusalByline(undefined, {})).toBeNull();
    expect(lossReasonText(undefined, {})).toBeNull();
  });
});
