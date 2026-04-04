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
        <div className="text-3xl font-bold font-mono tabular-nums tracking-tight">{value}</div>
        {subtext && (
          <p className="mt-1 text-xs text-muted-foreground">{subtext}</p>
        )}
      </CardContent>
    </Card>
  );
}
