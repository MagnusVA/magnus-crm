import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MemberIdentity } from "@/app/workspace/_components/member-identity";
import { OverviewHelpTooltip } from "@/app/workspace/_components/overview-help-tooltip";

type ConversionRow = FunctionReturnType<
  typeof api.leadGen.conversions.listProspectConversions
>[number];
type Stage = keyof ConversionRow["counts"];

const STAGES: Array<{ stage: Stage; label: string }> = [
  { stage: "prospect", label: "Prospects" },
  { stage: "in_conversation", label: "In conversation" },
  { stage: "qualified", label: "Qualified" },
  { stage: "booked", label: "Booked" },
  { stage: "showed", label: "Showed" },
  { stage: "customer", label: "Customer" },
];

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});
const percentFormatter = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

const SECTION_TOOLTIP =
  "Prospects each specialist first captured in the selected range, and how many of those people went on to reach each stage. A stage counts only if the person reached it after the capture, so capturing someone already qualified credits the prospect, not the qualification. All sources.";

function Cell({ count, prospects }: { count: number; prospects: number }) {
  return (
    <TableCell className="text-right tabular-nums">
      {numberFormatter.format(count)}
      {prospects > 0 && count !== prospects ? (
        <span className="ml-1 text-xs text-muted-foreground">
          {percentFormatter.format(count / prospects)}
        </span>
      ) : null}
    </TableCell>
  );
}

export function ProspectConversionTable({
  rows,
}: {
  rows: ConversionRow[] | undefined;
}) {
  const totals = Object.fromEntries(
    STAGES.map(({ stage }) => [
      stage,
      (rows ?? []).reduce((sum, row) => sum + row.counts[stage], 0),
    ]),
  ) as Record<Stage, number>;

  return (
    <Card className="min-w-0" size="sm">
      <CardHeader>
        <CardTitle>
          <OverviewHelpTooltip
            description={SECTION_TOOLTIP}
            label="Prospect Conversion"
          >
            Prospect Conversion
          </OverviewHelpTooltip>
        </CardTitle>
        <CardDescription className="text-xs">
          Prospects first captured in the selected range, by the specialist who
          captured them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows === undefined ? (
          <Skeleton className="h-[240px] w-full" />
        ) : rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No Prospects</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>No prospects were first captured in this range.</EmptyContent>
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="font-semibold text-foreground/80">
                    Lead Gen Specialist
                  </TableHead>
                  {STAGES.map(({ stage, label }) => (
                    <TableHead
                      key={stage}
                      className="text-right font-semibold text-foreground/80"
                    >
                      {label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.workerId}>
                    <TableCell className="max-w-0 min-w-48">
                      <MemberIdentity identity={row.worker} />
                    </TableCell>
                    {STAGES.map(({ stage }) => (
                      <Cell
                        key={stage}
                        count={row.counts[stage]}
                        prospects={row.counts.prospect}
                      />
                    ))}
                  </TableRow>
                ))}
                <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
                  <TableCell>Total</TableCell>
                  {STAGES.map(({ stage }) => (
                    <Cell key={stage} count={totals[stage]} prospects={totals.prospect} />
                  ))}
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
