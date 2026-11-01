import { describe, expect, it } from "vitest";
import { formatPhone } from "./phone";

describe("formatPhone", () => {
  it("groups a North American number stored as digits", () => {
    expect(formatPhone("+15005559610")).toBe("+1 500 555 9610");
    expect(formatPhone("15005559610")).toBe("+1 500 555 9610");
    expect(formatPhone("5005559610")).toBe("+1 500 555 9610");
  });

  it("keeps a number that is already grouped", () => {
    expect(formatPhone("+504 8282-8282")).toBe("+504 8282-8282");
    expect(formatPhone(" (305) 555-0147 ")).toBe("(305) 555-0147");
  });

  it("leaves other countries' bare digits as stored", () => {
    expect(formatPhone("+50482828282")).toBe("+50482828282");
    expect(formatPhone("+525512349876")).toBe("+525512349876");
  });
});
