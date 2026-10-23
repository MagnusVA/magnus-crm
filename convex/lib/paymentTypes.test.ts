import { expect, it } from "vitest";
import { normalizePaymentOrigin } from "./paymentTypes";

it("normalizes the legacy customer flow to a meeting payment", () => {
  expect(normalizePaymentOrigin("customer_flow")).toBe("closer_meeting");
});
