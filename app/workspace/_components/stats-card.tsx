"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface StatsCardProps {
  icon: LucideIcon;
  label: string;
  value: number | string;
  subtext?: string;
  /**
   * Visual treatment:
   * - `primary`     — headline / hero metric (accent border + ring).
   * - `default`     — standard card (no accent).
   * - `muted`       — informational / lower-emphasis card (neutral bg).
   * - `success`     — positive-outcome accent (emerald).
   * - `warning`     — caution accent (amber).
   * - `destructive` — negative-outcome accent (red).
   */
  variant?:
    | "default"
    | "primary"
    | "muted"
    | "success"
    | "warning"
    | "destructive";
  size?: "default" | "sm";
  className?: string;
}

const variantClasses = {
  default: "",
  primary: "border-primary/30 bg-primary/5 ring-1 ring-primary/10",
  muted: "border-border bg-muted/40",
  success: "border-emerald-500/20 bg-emerald-500/5",
  warning: "border-amber-500/20 bg-amber-500/5",
  destructive: "border-destructive/20 bg-destructive/5",
} as const;

export function StatsCard({
  icon: Icon,
  label,
  value,
  subtext,
  variant = "default",
  size = "default",
  className,
}: StatsCardProps) {
  return (
    <Card size={size} className={cn(variantClasses[variant], className)}>
      <CardHeader className={cn(size === "sm" ? "pb-1" : "pb-3")}>
        <div className="flex items-start justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {label}
          </CardTitle>
          <Icon
            className={cn(
              "text-muted-foreground/60",
              size === "sm" ? "size-4" : "size-5",
            )}
          />
        </div>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "font-mono font-bold tabular-nums",
            size === "sm" ? "text-2xl" : "text-3xl",
          )}
        >
          {value}
        </div>
        {subtext && (
          <p className="mt-1 text-xs text-muted-foreground">{subtext}</p>
        )}
      </CardContent>
    </Card>
  );
}
