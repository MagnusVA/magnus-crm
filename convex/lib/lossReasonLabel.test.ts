import { describe, expect, it } from "vitest";
import { isReservedLossReason } from "../opportunities/stages";
import { assertTypedLossReason } from "../opportunities/reservedLossReason";
import { lossReasonLabel } from "./lossReasonLabel";

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
