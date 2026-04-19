"use client";

import { ClipboardCheckIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface FormResponseRateCardProps {
  rate: number | null;
  numerator: number;
  denominator: number;
}

export function FormResponseRateCard({
  rate,
  numerator,
  denominator,
}: FormResponseRateCardProps) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-muted-foreground">
          <ClipboardCheckIcon className="size-4" />
          Form Response Rate
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">
          {rate === null ? "\u2014" : `${(rate * 100).toFixed(1)}%`}
        </div>
        <p className="text-xs text-muted-foreground">
          {numerator.toLocaleString()} of {denominator.toLocaleString()}{" "}
          meetings answered at least one field
        </p>
      </CardContent>
    </Card>
  );
}
