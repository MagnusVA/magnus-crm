"use client";

import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { SettingRow } from "@/app/workspace/settings/_components/settings-ui";
import { cn } from "@/lib/utils";
import { CardFooter, Fact, ROW_FIGURE, formatTime, type AffectedCall, type CandidateCloser } from "./redistribute-ui";

// Step 3: one call that autoDistributeMeetings couldn't place at a time:
// its facts, a closer to assign it to, or Cancel call (confirmed first).

/** The server's reasons, in the page's words; anything else shows as sent. */
function whyUnassigned(reason: string | undefined, closerName: string) {
  if (!reason) return null;
  if (reason === "No available closer with a free time slot") return "None of the chosen closers was free then.";
  if (reason === "Meeting is no longer assigned to the unavailable closer") return `It's no longer ${closerName}'s call.`;
  if (reason === "Meeting has no assigned closer") return "It has no closer.";
  if (reason.startsWith("Meeting is already ")) return `It's already ${reason.slice("Meeting is already ".length)}.`;
  return reason;
}

export function ResolveStep({
  call,
  reason,
  closerName,
  index,
  total,
  closers,
  closerId,
  onCloserChange,
  onAssign,
  onCancelCall,
  resolving,
}: {
  call: AffectedCall | null;
  /** Why the server left it unassigned. */
  reason: string | undefined;
  /** The closer who's out. */
  closerName: string;
  index: number;
  total: number;
  /** Closers who aren't off all day. */
  closers: CandidateCloser[];
  closerId: string;
  onCloserChange: (value: string) => void;
  onAssign: () => void;
  /** Opens the confirmation. */
  onCancelCall: () => void;
  resolving: "assign" | "cancel" | null;
}) {
  if (!call) {
    return (
      <section className={CARD}>
        <CardHead title="Assign or cancel" />
        <SectionEmpty title="No calls left to resolve." />
      </section>
    );
  }

  const why = whyUnassigned(reason, closerName);

  return (
    <section aria-labelledby="resolve-title" className={cn(CARD, "@container")}>
      <CardHead title={<span id="resolve-title">Assign or cancel</span>} meta={`${index + 1} of ${total}`} />
      <dl className="border-b border-border py-1">
        <Fact label="Lead">
          <span className="font-medium" translate="no">
            {call.leadName ?? "Unknown lead"}
          </span>
        </Fact>
        <Fact label="Time">
          <span className={ROW_FIGURE}>{formatTime(call.scheduledAt)}</span>
          <span className="text-muted-foreground"> · {call.durationMinutes} min</span>
        </Fact>
        {why ? <Fact label="Not moved">{why}</Fact> : null}
      </dl>
      <FieldGroup className="gap-0">
        <SettingRow label="Assign to" htmlFor="resolve-closer-select">
          <Select value={closerId} onValueChange={onCloserChange} disabled={resolving !== null}>
            <SelectTrigger id="resolve-closer-select" className="w-full">
              <SelectValue placeholder="Pick a closer" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {closers.map((closer) => (
                  <SelectItem key={closer.closerId} value={closer.closerId}>
                    {closer.closerName}
                    <span className="text-muted-foreground">
                      {" · "}
                      {closer.meetingsToday} {closer.meetingsToday === 1 ? "call" : "calls"}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>
      </FieldGroup>
      <CardFooter
        aside={
          <Button
            variant="outline"
            onClick={onCancelCall}
            disabled={resolving !== null}
            className="text-danger-ink hover:text-danger-ink"
          >
            Cancel call…
          </Button>
        }
      >
        <Button onClick={onAssign} disabled={!closerId || resolving !== null} className="font-semibold">
          {resolving === "assign" ? <Spinner data-icon="inline-start" /> : null}
          {resolving === "assign" ? "Assigning…" : "Assign"}
        </Button>
      </CardFooter>
    </section>
  );
}
