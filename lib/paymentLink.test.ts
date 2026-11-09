import { describe, expect, it } from "vitest";
import {
  buildPaymentDialogLink,
  buildPaymentLink,
  opensPaymentDialog,
  readPaymentLink,
} from "./paymentLink";

describe("the payment link", () => {
  const values = { amount: 1500.5, currency: "usd", paymentType: "deposit", programId: "prog_1" } as const;

  it("builds the receipt page's link for a meeting and for a task", () => {
    expect(buildPaymentLink({ meetingId: "m_1", ...values })).toBe(
      "/workspace/closer/pay?meetingId=m_1&amount=1500.5&currency=USD&type=deposit&program=prog_1",
    );
    expect(buildPaymentLink({ followUpId: "f_1", amount: 20 }, { baseUrl: "https://app.example.com" })).toBe(
      "https://app.example.com/workspace/closer/pay?followUpId=f_1&amount=20",
    );
  });

  it("builds the full dialog's link on the meeting or task page", () => {
    expect(buildPaymentDialogLink({ meetingId: "m_1", ...values })).toBe(
      "/workspace/closer/meetings/m_1?logPayment=1&amount=1500.5&currency=USD&type=deposit&program=prog_1",
    );
    expect(buildPaymentDialogLink({ followUpId: "f_1" })).toBe("/workspace/closer/reminders/f_1?logPayment=1");
  });

  it("reads back what it builds, and drops values that aren't valid", () => {
    const link = new URL(buildPaymentLink({ meetingId: "m_1", ...values }), "https://x.test");
    expect(readPaymentLink(link.searchParams)).toEqual({
      meetingId: "m_1", amount: 1500.5, currency: "USD", paymentType: "deposit", programId: "prog_1",
    });
    const bad = new URLSearchParams("followUpId=f_1&amount=-3&currency=dollars&type=gift&program=");
    expect(readPaymentLink(bad)).toEqual({ followUpId: "f_1" });
    expect(readPaymentLink(new URLSearchParams("amount=5"))).toBeNull();
  });

  it("opens the dialog only for logPayment=1", () => {
    expect(opensPaymentDialog(new URLSearchParams("logPayment=1"))).toBe(true);
    expect(opensPaymentDialog(new URLSearchParams("logPayment=0"))).toBe(false);
  });
});
