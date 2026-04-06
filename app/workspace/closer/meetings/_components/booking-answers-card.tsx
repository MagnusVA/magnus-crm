"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Character threshold above which an answer gets a "Show more" toggle. */
const LONG_ANSWER_THRESHOLD = 120;

const answerTextClasses = "text-sm leading-relaxed break-words";

type BookingAnswersCardProps = {
  customFields: unknown;
};

/**
 * Displays Calendly booking-form answers as a definition list.
 *
 * - Uses <dl>/<dt>/<dd> for semantic correctness (question → answer pairs).
 * - Hides entirely when customFields is absent / empty / malformed.
 * - Long answers (>120 chars) collapse behind a Collapsible toggle.
 * - Uses a responsive 2-column grid to stay compact in wide containers.
 */
export function BookingAnswersCard({ customFields }: BookingAnswersCardProps) {
  if (!isStringRecord(customFields)) return null;

  const entries = Object.entries(customFields).filter(
    ([, v]) => v.length > 0,
  );
  if (entries.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Booking Answers</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {entries.map(([question, answer]) => (
            <div key={question} className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {question}
              </dt>
              {answer.length > LONG_ANSWER_THRESHOLD ? (
                <CollapsibleAnswer answer={answer} />
              ) : (
                <dd className={cn("mt-1", answerTextClasses)}>
                  {answer}
                </dd>
              )}
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

// ─── Internal ──────────────────────────────────────────────────────────

function CollapsibleAnswer({ answer }: { answer: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <dd className="mt-1">
        <p
          className={cn(
            answerTextClasses,
            !open && "line-clamp-3",
          )}
        >
          {answer}
        </p>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
          >
            {open ? "Show less" : "Show more"}
            <ChevronDownIcon
              className={cn(
                "size-3 transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        </CollapsibleTrigger>
      </dd>
    </Collapsible>
  );
}

/**
 * Runtime guard: true when value is a non-empty Record<string, string>.
 *
 * Rejects: null, undefined, arrays, objects with non-string values,
 * empty objects.
 */
function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return false;
  return entries.every(([, v]) => typeof v === "string");
}
