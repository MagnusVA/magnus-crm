import { describe, expect, it } from "vitest";
import { formatCloseRate } from "@/app/workspace/operations/sales-calls/_components/close-rate";
import {
  buildHistoricalSalesDashboard,
  closeRateOfRow,
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
        totalCalls: 7,
        showed: 3,
        canceled: 1,
        noShows: 1,
        showUpRate: 0.5,
          resultsRecorded: 4,
          pastCalls: 6,
        cohortDeals: 4,
        wonDeals: 1,
        closeRate: 0.25,
        start: 100,
        end: 200,
      },
      summaryMoneyRows: [
        row("EUR", {
          currency: "eur",
          paymentSalesCount: 2,
          cashCollectedMinor: 80000,
          avgCashPerSaleMinor: 40000,
        }),
        row("USD", {
          currency: "usd",
          paymentSalesCount: 1,
          cashCollectedMinor: 50000,
          avgCashPerSaleMinor: 50000,
        }),
      ],
      closerRows: [
        row("closer-1", {
          closerId: "closer-1",
          label: "Ana",
          booked: 7,
          showed: 3,
          canceled: 1,
          noShows: 1,
          showUpRate: 0.5,
          resultsRecorded: 4,
          pastCalls: 6,
          cohortDeals: 4,
          wonDeals: 1,
          closeRate: 0.25,
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
          avgPaymentDealMinor: 40000,
        }, "closer-1"),
        row("closer-1:USD", {
          currency: "USD",
          paymentSales: 1,
          paymentRevenueMinor: 50000,
          avgPaymentDealMinor: 50000,
        }, "closer-1"),
      ],
      programRows: [
        row("program-1", {
          programId: "program-1",
          label: "Program One",
          calls: 7,
          showed: 3,
          canceled: 1,
          noShows: 1,
          showUpRate: 0.5,
          resultsRecorded: 4,
          pastCalls: 6,
          cohortDeals: 4,
          wonDeals: 1,
          closeRate: 0.25,
        }),
      ],
      programMoneyRows: [
        row("program-1:EUR", {
          currency: "EUR",
          paymentSales: 2,
          paymentRevenueMinor: 80000,
          avgPaymentDealMinor: 40000,
        }, "program-1"),
        row("program-1:USD", {
          currency: "USD",
          paymentSales: 1,
          paymentRevenueMinor: 50000,
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
    expect(dashboard.stats.totalCalls).toBe(7);
    for (const result of [dashboard.stats, dashboard.closers[0], dashboard.perProgram[0], dashboard.teamTotal]) {
      expect(result).toMatchObject({ showUpRate: 0.75, resultsRecorded: 4, pastCalls: 6 });
      // One currency-independent close rate from the cohort sums.
      expect(result).toMatchObject({ closeRate: 0.25, cohortDeals: 4, wonDeals: 1 });
    }
    expect(dashboard.stats.moneyByCurrency[0]).not.toHaveProperty("closeRate");
    expect(dashboard.closers[0].moneyByCurrency[0]).not.toHaveProperty("paymentCloseRate");
  });

  it("reads an answer cached before the close rate fields as unknown, not 0%", () => {
    // Shapes a ClickHouse answer cached before the cohort fields can have.
    expect(closeRateOfRow({})).toBeNull();
    expect(closeRateOfRow({ closeRate: undefined })).toBeNull();
    expect(formatCloseRate({})).toBe("—");
    expect(formatCloseRate({ closeRate: null, cohortDeals: 0, wonDeals: 0 })).toBe("—");
    expect(closeRateOfRow({ closeRate: 0, cohortDeals: 3, wonDeals: 0 }))
      .toEqual({ closeRate: 0, cohortDeals: 3, wonDeals: 0 });
  });

  it("defaults to the only available non-USD currency", () => {
    expect(defaultSalesCurrency(["HNL"])).toBe("HNL");
  });
});
