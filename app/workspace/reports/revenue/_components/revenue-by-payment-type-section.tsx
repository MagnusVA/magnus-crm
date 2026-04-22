"use client";

import {
  BanknoteIcon,
  CalendarClockIcon,
  LayersIcon,
  PiggyBankIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatAmountMinor } from "@/lib/format-currency";
import { cn } from "@/lib/utils";

interface PaymentTypeBreakdown {
  pif: number;
  split: number;
  monthly: number;
  deposit: number;
}

interface RevenueByPaymentTypeSectionProps {
  byPaymentType: PaymentTypeBreakdown;
}

const TYPE_META: Array<{
  key: keyof PaymentTypeBreakdown;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    key: "pif",
    label: "PIF",
    description: "Paid in full",
    icon: BanknoteIcon,
  },
  {
    key: "split",
    label: "Split",
    description: "Split payments",
    icon: LayersIcon,
  },
  {
    key: "monthly",
    label: "Monthly",
    description: "Monthly payments",
    icon: CalendarClockIcon,
  },
  {
    key: "deposit",
    label: "Deposit",
    description: "Deposits collected",
    icon: PiggyBankIcon,
  },
];

export function RevenueByPaymentTypeSection({
  byPaymentType,
}: RevenueByPaymentTypeSectionProps) {
  const leadingKey = TYPE_META.reduce<keyof PaymentTypeBreakdown | null>(
    (leading, meta) => {
      const current = byPaymentType[meta.key];
      if (current === 0) {
        return leading;
      }
      if (leading === null || current > byPaymentType[leading]) {
        return meta.key;
      }
      return leading;
    },
    null,
  );

  const hasAny = TYPE_META.some((meta) => byPaymentType[meta.key] > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue by Payment Type</CardTitle>
        <CardDescription>
          Totals per payment type across all selected slices and programs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!hasAny ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No payments in this period
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {TYPE_META.map((meta) => {
              const amount = byPaymentType[meta.key];
              const isLeading = meta.key === leadingKey;
              const Icon = meta.icon;
              return (
                <div
                  key={meta.key}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border bg-card p-4 transition-colors",
                    isLeading
                      ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
                      : undefined,
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-muted-foreground">
                      {meta.label}
                    </span>
                    <Icon
                      className={cn(
                        "size-4",
                        isLeading
                          ? "text-primary"
                          : "text-muted-foreground/70",
                      )}
                      aria-hidden
                    />
                  </div>
                  <div className="text-2xl font-semibold tabular-nums">
                    {formatAmountMinor(amount, "USD")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {meta.description}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
