"use client";

import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatAmountMinor } from "@/lib/format-currency";
import { cn } from "@/lib/utils";

type RevenueMetrics = FunctionReturnType<
  typeof api.reporting.revenue.getRevenueMetrics
>;
type ProgramRow =
  RevenueMetrics["commissionable"]["byProgram"][number];

interface RevenueByProgramSectionProps {
  commissionable: ReadonlyArray<ProgramRow>;
  nonCommissionable: ReadonlyArray<ProgramRow>;
}

function combinedTotal(row: ProgramRow): number {
  return row.finalRevenueMinor + row.depositRevenueMinor;
}

function maxTotalOf(rows: ReadonlyArray<ProgramRow>): number {
  return rows.reduce(
    (maxSoFar, row) => Math.max(maxSoFar, combinedTotal(row)),
    0,
  );
}

interface ProgramListProps {
  title: string;
  description: string;
  emptyMessage: string;
  rows: ReadonlyArray<ProgramRow>;
  accentClassName: string;
}

function ProgramList({
  title,
  description,
  emptyMessage,
  rows,
  accentClassName,
}: ProgramListProps) {
  const topValue = maxTotalOf(rows);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {emptyMessage}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((row) => {
              const total = combinedTotal(row);
              const widthPercent =
                topValue > 0 ? Math.max(4, (total / topValue) * 100) : 0;
              return (
                <li
                  key={row.programId ?? row.programName}
                  className="flex flex-col gap-1.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{row.programName}</span>
                      <Badge variant="outline" className="tabular-nums">
                        {row.paymentCount} payment
                        {row.paymentCount === 1 ? "" : "s"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-sm tabular-nums">
                      <span className="font-semibold">
                        {formatAmountMinor(row.finalRevenueMinor, "USD")}
                      </span>
                      <span className="text-muted-foreground">
                        +{formatAmountMinor(row.depositRevenueMinor, "USD")}{" "}
                        dep.
                      </span>
                    </div>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        accentClassName,
                      )}
                      style={{ width: `${widthPercent}%` }}
                      aria-hidden
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function RevenueByProgramSection({
  commissionable,
  nonCommissionable,
}: RevenueByProgramSectionProps) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <ProgramList
        title="Commissionable by Program"
        description="Meeting / reminder / review-resolution revenue per program"
        emptyMessage="No commissionable program revenue in this period"
        rows={commissionable}
        accentClassName="bg-primary"
      />
      <ProgramList
        title="Post-Conversion by Program"
        description="Customer-direct / bookkeeper revenue per program"
        emptyMessage="No post-conversion program revenue in this period"
        rows={nonCommissionable}
        accentClassName="bg-muted-foreground/60"
      />
    </div>
  );
}
