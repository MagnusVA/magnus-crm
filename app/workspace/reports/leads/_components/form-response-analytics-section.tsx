"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { FieldAnswerDistribution } from "./field-answer-distribution";

interface FormResponseAnalyticsSectionProps {
  dateRange: { startDate: number; endDate: number };
}

export function FormResponseAnalyticsSection({
  dateRange,
}: FormResponseAnalyticsSectionProps) {
  const [selectedFieldKey, setSelectedFieldKey] = useState<string | null>(null);

  const catalog = useQuery(
    api.reporting.formResponseAnalytics.getFieldCatalog,
  );

  const distribution = useQuery(
    api.reporting.formResponseAnalytics.getAnswerDistribution,
    selectedFieldKey
      ? {
          fieldKey: selectedFieldKey,
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
        }
      : "skip",
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Booking Form Insights</CardTitle>
        <CardDescription>
          Analyze responses from Calendly booking form questions
        </CardDescription>
      </CardHeader>
      <CardContent>
        {catalog === undefined ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-[300px]" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : catalog.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Calendly form fields have been captured yet. Form response data
            will appear here after bookings with custom questions are processed.
          </p>
        ) : (
          <div className="space-y-4">
            <Select
              value={selectedFieldKey ?? undefined}
              onValueChange={(value) => setSelectedFieldKey(value)}
            >
              <SelectTrigger className="w-[300px]">
                <SelectValue placeholder="Select a form field..." />
              </SelectTrigger>
              <SelectContent>
                {catalog.map((field) => (
                  <SelectItem key={field.id} value={field.fieldKey}>
                    {field.currentLabel}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {selectedFieldKey !== null && distribution === undefined && (
              <div className="space-y-3">
                <Skeleton className="h-6 w-64" />
                <Skeleton className="h-64 w-full" />
              </div>
            )}

            {distribution !== undefined && (
              <FieldAnswerDistribution distribution={distribution} />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
