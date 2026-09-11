import { describe, expect, it } from "vitest";
import {
  buildHistoricalSalesDashboard,
  defaultSalesCurrency,
  listSalesCurrencies,
  performanceMoneyForCurrency,
} from "@/app/workspace/operations/sales-calls/_components/sales-calls-data";

const row = (
  rowKey: string,
  payload: Record<string, string | number | boolean | null>,
  groupKey?: string,
) => ({ rowKey, payload, ...(groupKey ? { groupKey } : {}) });

describe("historical Sales Calls dashboard adapter", () => {
  it("joins money by currency without summing unlike currencies", () => {
    const dashboard = buildHistoricalSalesDashboard({
      summary: {
        totalCalls: 4,
        showed: 3,
        canceled: 0,
        noShows: 1,
        showUpRate: 0.75,
        start: 100,
        end: 200,
      },
      summaryMoneyRows: [
        row("EUR", {
          currency: "eur",
          paymentSalesCount: 2,
          cashCollectedMinor: 80000,
          closeRate: 2 / 3,
          avgCashPerSaleMinor: 40000,
        }),
        row("USD", {
          currency: "usd",
          paymentSalesCount: 1,
          cashCollectedMinor: 50000,
          closeRate: 1 / 3,
          avgCashPerSaleMinor: 50000,
        }),
      ],
      closerRows: [
        row("closer-1", {
          closerId: "closer-1",
          label: "Ana",
          booked: 4,
          showed: 3,
          canceled: 0,
          noShows: 1,
          showUpRate: 0.75,
          identityId: "user-1",
          identityName: "Ana",
          identitySource: "crm_user",
        }),
      ],
      closerMoneyRows: [
        row("closer-1:EUR", {
          currency: "EUR",
          paymentSales: 2,
          paymentRevenueMinor: 80000,
          paymentCloseRate: 2 / 3,
          avgPaymentDealMinor: 40000,
        }, "closer-1"),
        row("closer-1:USD", {
          currency: "USD",
          paymentSales: 1,
          paymentRevenueMinor: 50000,
          paymentCloseRate: 1 / 3,
          avgPaymentDealMinor: 50000,
        }, "closer-1"),
      ],
      programRows: [
        row("program-1", {
          programId: "program-1",
          label: "Program One",
          calls: 4,
          showed: 3,
          canceled: 0,
          noShows: 1,
          showUpRate: 0.75,
        }),
      ],
      programMoneyRows: [
        row("program-1:EUR", {
          currency: "EUR",
          paymentSales: 2,
          paymentRevenueMinor: 80000,
          paymentCloseRate: 2 / 3,
          avgPaymentDealMinor: 40000,
        }, "program-1"),
        row("program-1:USD", {
          currency: "USD",
          paymentSales: 1,
          paymentRevenueMinor: 50000,
          paymentCloseRate: 1 / 3,
          avgPaymentDealMinor: 50000,
        }, "program-1"),
      ],
    });

    expect(listSalesCurrencies(dashboard)).toEqual(["EUR", "USD"]);
    expect(defaultSalesCurrency(listSalesCurrencies(dashboard))).toBe("USD");
    expect(performanceMoneyForCurrency(dashboard.closers[0], "EUR"))
      .toMatchObject({ paymentSales: 2, paymentRevenueMinor: 80000 });
    expect(performanceMoneyForCurrency(dashboard.closers[0], "USD"))
      .toMatchObject({ paymentSales: 1, paymentRevenueMinor: 50000 });
    expect(dashboard.teamTotal.moneyByCurrency).toEqual([
      expect.objectContaining({ currency: "EUR", paymentRevenueMinor: 80000 }),
      expect.objectContaining({ currency: "USD", paymentRevenueMinor: 50000 }),
    ]);
    expect(dashboard.stats.totalCalls).toBe(4);
  });

  it("defaults to the only available non-USD currency", () => {
    expect(defaultSalesCurrency(["HNL"])).toBe("HNL");
  });
});
