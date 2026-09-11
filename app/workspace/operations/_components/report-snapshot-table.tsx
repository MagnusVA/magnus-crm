"use client";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  TablePropertiesIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type ReportScalar = string | number | boolean | null;

export type ReportSnapshotRow = {
  rowKey: string;
  payload: Record<string, ReportScalar>;
};

export type ReportSnapshotColumn = {
  key: string;
  label: string;
  align?: "left" | "right";
  render?: (value: ReportScalar) => string;
};

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
});

function defaultValue(value: ReportScalar) {
  if (value === null) return "—";
  if (typeof value === "number") return numberFormatter.format(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value;
}

export function numberField(
  payload: Record<string, ReportScalar>,
  key: string,
  fallback = 0,
) {
  const value = payload[key];
  return typeof value === "number" ? value : fallback;
}

export function nullableNumberField(
  payload: Record<string, ReportScalar>,
  key: string,
) {
  const value = payload[key];
  return typeof value === "number" ? value : null;
}

export function textField(
  payload: Record<string, ReportScalar>,
  key: string,
  fallback = "—",
) {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function OperationsReportSnapshotTable({
  title,
  description,
  columns,
  rows,
  isLoading,
  hasPreviousPage,
  hasNextPage,
  onPreviousPage,
  onNextPage,
}: {
  title: string;
  description: string;
  columns: ReportSnapshotColumn[];
  rows: ReportSnapshotRow[] | undefined;
  isLoading?: boolean;
  hasPreviousPage?: boolean;
  hasNextPage?: boolean;
  onPreviousPage?: () => void;
  onNextPage?: () => void;
}) {
  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isLoading || rows === undefined ? (
          <Skeleton
            className="h-[280px] w-full"
            role="status"
            aria-label={`Loading ${title}`}
          />
        ) : rows.length === 0 ? (
          <Empty className="min-h-48 border p-4">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TablePropertiesIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No results in this report</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              This completed historical report has no rows for this section.
            </EmptyContent>
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-max">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  {columns.map((column) => (
                    <TableHead
                      key={column.key}
                      className={
                        column.align === "right"
                          ? "text-right font-semibold text-foreground/80"
                          : "font-semibold text-foreground/80"
                      }
                    >
                      {column.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.rowKey}>
                    {columns.map((column) => {
                      const value = row.payload[column.key] ?? null;
                      return (
                        <TableCell
                          key={column.key}
                          className={
                            column.align === "right"
                              ? "text-right tabular-nums"
                              : "max-w-72 truncate"
                          }
                        >
                          {column.render
                            ? column.render(value)
                            : defaultValue(value)}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {hasPreviousPage || hasNextPage ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              aria-label="Previous report rows"
              disabled={!hasPreviousPage}
              size="sm"
              variant="outline"
              onClick={onPreviousPage}
            >
              <ChevronLeftIcon data-icon="inline-start" />
              Previous
            </Button>
            <Button
              aria-label="Next report rows"
              disabled={!hasNextPage}
              size="sm"
              variant="outline"
              onClick={onNextPage}
            >
              Next
              <ChevronRightIcon data-icon="inline-end" />
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
