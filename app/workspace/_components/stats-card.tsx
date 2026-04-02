"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface StatsCardProps {
  icon: LucideIcon;
  label: string;
  value: number | string;
  subtext?: string;
  variant?: "default" | "success" | "warning" | "destructive";
}

const variantClasses = {
  default: "",
  success:
    "border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/50",
  warning:
    "border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/50",
  destructive:
    "border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/50",
} as const;

export function StatsCard({
  icon: Icon,
  label,
  value,
  subtext,
  variant = "default",
}: StatsCardProps) {
  return (
    <Card className={cn(variantClasses[variant])}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {label}
          </CardTitle>
          <Icon className="size-5 text-muted-foreground/60" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold tracking-tight">{value}</div>
        {subtext && (
          <p className="mt-1 text-xs text-muted-foreground">{subtext}</p>
        )}
      </CardContent>
    </Card>
  );
}
