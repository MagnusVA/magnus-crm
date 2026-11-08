"use client";

import { Button } from "@/components/ui/button";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { CardFooter, Fact, ROW_FIGURE } from "./redistribute-ui";

// Step 4: what happened, as dense facts, and the way back.

export function DoneStep({
  movedTo,
  canceledCount,
  onBackToTeam,
}: {
  /** Each closer who took calls, with how many, most first. */
  movedTo: Array<{ name: string; count: number }>;
  canceledCount: number;
  onBackToTeam: () => void;
}) {
  const moved = movedTo.reduce((sum, closer) => sum + closer.count, 0);

  return (
    <section aria-labelledby="done-title" className={CARD}>
      <CardHead title={<span id="done-title">Result</span>} />
      <dl className="py-1">
        <Fact label="Moved">
          <span className={ROW_FIGURE}>{moved}</span> {moved === 1 ? "call" : "calls"}
        </Fact>
        {movedTo.length > 0 ? (
          <Fact label="To">
            {movedTo.map((closer, index) => (
              <span key={closer.name}>
                {index > 0 ? ", " : null}
                <span translate="no">{closer.name}</span>{" "}
                <span className="font-condensed text-[15px] font-semibold text-muted-foreground tabular-nums">
                  {closer.count}
                </span>
              </span>
            ))}
          </Fact>
        ) : null}
        {canceledCount > 0 ? (
          <Fact label="Canceled">
            <span className={ROW_FIGURE}>{canceledCount}</span> {canceledCount === 1 ? "call" : "calls"}
          </Fact>
        ) : null}
      </dl>
      <CardFooter>
        <Button onClick={onBackToTeam} className="font-semibold">
          Back to Team
        </Button>
      </CardFooter>
    </section>
  );
}
