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
  answers: Array<{
    fieldKey: string;
    question: string;
    answer: string;
    capturedAt: number;
  }>;
};

/**
 * Displays Calendly booking-form answers as a definition list.
 *
 * - Uses <dl>/<dt>/<dd> for semantic correctness (question → answer pairs).
 * - Hides blank answers and shows an empty state when none remain.
 * - Long answers (>120 chars) collapse behind a Collapsible toggle.
 * - Uses a responsive 2-column grid to stay compact in wide containers.
 */
export function BookingAnswersCard({ answers }: BookingAnswersCardProps) {
  const entries = answers.filter(({ answer }) => answer.trim().length > 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Booking Answers</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No answers stored for this booking
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            {entries.map(({ fieldKey, question, answer, capturedAt }) => (
              <div key={`${capturedAt}:${fieldKey}`} className="min-w-0">
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
        )}
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
            className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
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
