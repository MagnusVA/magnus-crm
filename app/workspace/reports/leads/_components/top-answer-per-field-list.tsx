"use client";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";

interface FieldRow {
  fieldKey: string;
  topAnswer: string;
  topAnswerCount: number;
  totalResponses: number;
  topAnswerShare: number;
}

function formatFieldKey(fieldKey: string) {
  return fieldKey
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function TopAnswerPerFieldList({ rows }: { rows: FieldRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Answer per Field</CardTitle>
        <CardDescription>
          Most common response for each captured booking-form field in the
          selected range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty className="border bg-muted/20 py-12">
            <EmptyHeader>
              <EmptyTitle>No form responses in range</EmptyTitle>
              <EmptyDescription>
                Booking form answers will appear here once meetings in the
                selected period include captured responses.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-4">
            {rows.map((row) => (
              <div key={row.fieldKey} className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">
                        {formatFieldKey(row.fieldKey)}
                      </p>
                      <Badge variant="outline">
                        {row.topAnswerCount}/{row.totalResponses}
                      </Badge>
                    </div>
                    <p
                      className="truncate text-sm text-muted-foreground"
                      title={row.topAnswer}
                    >
                      {row.topAnswer}
                    </p>
                  </div>
                  <p className="tabular-nums text-xs text-muted-foreground">
                    {(row.topAnswerShare * 100).toFixed(0)}%
                  </p>
                </div>
                <Progress
                  value={row.topAnswerShare * 100}
                  aria-label={`${formatFieldKey(row.fieldKey)} top answer share`}
                />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
