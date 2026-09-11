import type { MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import { dashboardIdentity } from "@/lib/operations-reports/dashboard-identity";

export type SalesSummaryMoney = {
  currency: string;
  paymentSalesCount: number;
  cashCollectedMinor: number;
  closeRate: number | null;
  avgCashPerSaleMinor: number | null;
};

export type SalesPerformanceMoney = {
  currency: string;
  paymentSales: number;
  paymentRevenueMinor: number;
  paymentCloseRate: number | null;
  avgPaymentDealMinor: number | null;
};

export type SalesCallsStats = {
  totalCalls: number;
  showed: number;
  canceled: number;
  noShows: number;
  showUpRate: number | null;
  moneyByCurrency: SalesSummaryMoney[];
};

export type SalesProgramRow = {
  programId: string | null;
  label: string;
  calls: number;
  showed: number;
  canceled: number;
  noShows: number;
  showUpRate: number | null;
  moneyByCurrency: SalesPerformanceMoney[];
};

export type SalesCloserRow = {
  closerId: string;
  label: string;
  avatar: MemberAvatarIdentity;
  booked: number;
  canceled: number;
  noShows: number;
  showed: number;
  showUpRate: number | null;
  moneyByCurrency: SalesPerformanceMoney[];
};

export type SalesTeamTotal = Omit<
  SalesCloserRow,
  "closerId" | "label" | "avatar"
>;

export type SalesDashboardView = {
  stats: SalesCallsStats;
  perProgram: SalesProgramRow[];
  closers: SalesCloserRow[];
  teamTotal: SalesTeamTotal;
  window: { start: number; end: number };
};

export type ReportResultRow = {
  rowKey: string;
  groupKey?: string;
  payload: Record<string, string | number | boolean | null>;
};

function numberValue(
  record: ReportResultRow["payload"],
  key: string,
  fallback = 0,
) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(record: ReportResultRow["payload"], key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(
  record: ReportResultRow["payload"],
  key: string,
  fallback: string,
) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function currencyValue(record: ReportResultRow["payload"]) {
  return stringValue(record, "currency", "USD").toUpperCase();
}

function performanceMoney(row: ReportResultRow): SalesPerformanceMoney {
  return {
    currency: currencyValue(row.payload),
    paymentSales: numberValue(row.payload, "paymentSales"),
    paymentRevenueMinor: numberValue(row.payload, "paymentRevenueMinor"),
    paymentCloseRate: nullableNumber(row.payload, "paymentCloseRate"),
    avgPaymentDealMinor: nullableNumber(row.payload, "avgPaymentDealMinor"),
  };
}

function groupMoneyRows(rows: ReportResultRow[]) {
  const grouped = new Map<string, SalesPerformanceMoney[]>();
  for (const row of rows) {
    const groupKey = row.groupKey ?? stringValue(row.payload, "groupKey", "");
    if (!groupKey) continue;
    const group = grouped.get(groupKey) ?? [];
    group.push(performanceMoney(row));
    grouped.set(groupKey, group);
  }
  for (const group of grouped.values()) {
    group.sort((left, right) => left.currency.localeCompare(right.currency));
  }
  return grouped;
}

function rate(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

function teamTotal(closers: SalesCloserRow[]): SalesTeamTotal {
  const totals = closers.reduce(
    (result, closer) => ({
      booked: result.booked + closer.booked,
      canceled: result.canceled + closer.canceled,
      noShows: result.noShows + closer.noShows,
      showed: result.showed + closer.showed,
    }),
    { booked: 0, canceled: 0, noShows: 0, showed: 0 },
  );
  const byCurrency = new Map<
    string,
    { paymentSales: number; paymentRevenueMinor: number }
  >();
  for (const closer of closers) {
    for (const money of closer.moneyByCurrency) {
      const currency = money.currency.toUpperCase();
      const current = byCurrency.get(currency) ?? {
        paymentSales: 0,
        paymentRevenueMinor: 0,
      };
      current.paymentSales += money.paymentSales;
      current.paymentRevenueMinor += money.paymentRevenueMinor;
      byCurrency.set(currency, current);
    }
  }
  return {
    ...totals,
    showUpRate: rate(totals.showed, totals.booked - totals.canceled),
    moneyByCurrency: [...byCurrency.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([currency, money]) => ({
        currency,
        ...money,
        paymentCloseRate: rate(money.paymentSales, totals.showed),
        avgPaymentDealMinor: rate(
          money.paymentRevenueMinor,
          money.paymentSales,
        ),
      })),
  };
}

export function buildHistoricalSalesDashboard(args: {
  summary: ReportResultRow["payload"];
  summaryMoneyRows: ReportResultRow[];
  closerRows: ReportResultRow[];
  closerMoneyRows: ReportResultRow[];
  programRows: ReportResultRow[];
  programMoneyRows: ReportResultRow[];
}): SalesDashboardView {
  const closerMoney = groupMoneyRows(args.closerMoneyRows);
  const programMoney = groupMoneyRows(args.programMoneyRows);
  const closers = args.closerRows.map((row): SalesCloserRow => {
    const closerId = stringValue(row.payload, "closerId", row.rowKey);
    const label = stringValue(row.payload, "label", "Removed closer");
    return {
      closerId,
      label,
      avatar: dashboardIdentity(row.payload, closerId, label),
      booked: numberValue(row.payload, "booked"),
      canceled: numberValue(row.payload, "canceled"),
      noShows: numberValue(row.payload, "noShows"),
      showed: numberValue(row.payload, "showed"),
      showUpRate: nullableNumber(row.payload, "showUpRate"),
      moneyByCurrency: closerMoney.get(closerId) ?? [],
    };
  });
  const perProgram = args.programRows.map((row): SalesProgramRow => {
    const programId = row.rowKey === "none"
      ? null
      : stringValue(row.payload, "programId", row.rowKey);
    return {
      programId,
      label: stringValue(row.payload, "label", "No program"),
      calls: numberValue(row.payload, "calls", numberValue(row.payload, "booked")),
      showed: numberValue(row.payload, "showed"),
      canceled: numberValue(row.payload, "canceled"),
      noShows: numberValue(row.payload, "noShows"),
      showUpRate: nullableNumber(row.payload, "showUpRate"),
      moneyByCurrency: programMoney.get(programId ?? "none") ?? [],
    };
  });

  return {
    stats: {
      totalCalls: numberValue(args.summary, "totalCalls"),
      showed: numberValue(args.summary, "showed"),
      canceled: numberValue(args.summary, "canceled"),
      noShows: numberValue(args.summary, "noShows"),
      showUpRate: nullableNumber(args.summary, "showUpRate"),
      moneyByCurrency: args.summaryMoneyRows
        .map((row) => ({
          currency: currencyValue(row.payload),
          paymentSalesCount: numberValue(row.payload, "paymentSalesCount"),
          cashCollectedMinor: numberValue(row.payload, "cashCollectedMinor"),
          closeRate: nullableNumber(row.payload, "closeRate"),
          avgCashPerSaleMinor: nullableNumber(
            row.payload,
            "avgCashPerSaleMinor",
          ),
        }))
        .sort((left, right) => left.currency.localeCompare(right.currency)),
    },
    perProgram,
    closers,
    teamTotal: teamTotal(closers),
    window: {
      start: numberValue(args.summary, "start"),
      end: numberValue(args.summary, "end"),
    },
  };
}

export function listSalesCurrencies(
  dashboard: SalesDashboardView | undefined,
) {
  const currencies = new Set<string>();
  for (const money of dashboard?.stats.moneyByCurrency ?? []) {
    currencies.add(money.currency.toUpperCase());
  }
  for (const row of dashboard?.closers ?? []) {
    for (const money of row.moneyByCurrency) {
      currencies.add(money.currency.toUpperCase());
    }
  }
  for (const row of dashboard?.perProgram ?? []) {
    for (const money of row.moneyByCurrency) {
      currencies.add(money.currency.toUpperCase());
    }
  }
  return [...currencies].sort((left, right) => left.localeCompare(right));
}

export function defaultSalesCurrency(currencies: string[]) {
  return currencies.includes("USD") ? "USD" : (currencies[0] ?? "USD");
}

export function performanceMoneyForCurrency(
  row: { showed: number; moneyByCurrency: SalesPerformanceMoney[] },
  currency: string,
): SalesPerformanceMoney {
  return row.moneyByCurrency.find(
    (money) => money.currency.toUpperCase() === currency.toUpperCase(),
  ) ?? {
    currency: currency.toUpperCase(),
    paymentSales: 0,
    paymentRevenueMinor: 0,
    paymentCloseRate: row.showed > 0 ? 0 : null,
    avgPaymentDealMinor: null,
  };
}

export function summaryMoneyForCurrency(
  stats: SalesCallsStats,
  currency: string,
): SalesSummaryMoney {
  return stats.moneyByCurrency.find(
    (money) => money.currency.toUpperCase() === currency.toUpperCase(),
  ) ?? {
    currency: currency.toUpperCase(),
    paymentSalesCount: 0,
    cashCollectedMinor: 0,
    closeRate: stats.showed > 0 ? 0 : null,
    avgCashPerSaleMinor: null,
  };
}
