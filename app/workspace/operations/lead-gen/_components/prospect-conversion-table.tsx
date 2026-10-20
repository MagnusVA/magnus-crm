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

type ConversionReport = FunctionReturnType<
  typeof api.leadGen.conversions.listProspectConversions
>;
type ConversionRow = ConversionReport["rows"][number];
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

const DEALS_TOOLTIP =
  "Deals whose person this specialist found first: their capture was the person's first touch when the deal was created. Counted by the capture's date.";

function Cell({
  count,
  prospects,
  showShare,
}: {
  count: number;
  prospects: number;
  showShare: boolean;
}) {
  return (
    <TableCell className="text-right tabular-nums">
      {numberFormatter.format(count)}
      {showShare && prospects > 0 ? (
        <span className="ml-1 text-xs text-muted-foreground">
          {percentFormatter.format(count / prospects)}
        </span>
      ) : null}
    </TableCell>
  );
}

export function ProspectConversionTable({
  report,
}: {
  report: ConversionReport | undefined;
}) {
  const rows = report?.rows;
  const totals = Object.fromEntries(
    STAGES.map(({ stage }) => [
      stage,
      (rows ?? []).reduce((sum, row) => sum + row.counts[stage], 0),
    ]),
  ) as Record<Stage, number>;
  const totalDeals = (rows ?? []).reduce((sum, row) => sum + row.deals, 0);

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
          {report?.capped ? " Showing the first 500 specialists only." : null}
          {report?.dealsCapped
            ? " Deals is partial: this range holds more deals than one read covers."
            : null}
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
                  <TableHead className="text-right font-semibold text-foreground/80">
                    <OverviewHelpTooltip
                      description={DEALS_TOOLTIP}
                      label="Deals"
                      triggerClassName="w-full justify-end"
                    >
                      Deals
                    </OverviewHelpTooltip>
                  </TableHead>
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
                        showShare={stage !== "prospect"}
                      />
                    ))}
                    <Cell
                      count={row.deals}
                      prospects={row.counts.prospect}
                      showShare={false}
                    />
                  </TableRow>
                ))}
                <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
                  <TableCell>Total</TableCell>
                  {STAGES.map(({ stage }) => (
                    <Cell
                      key={stage}
                      count={totals[stage]}
                      prospects={totals.prospect}
                      showShare={stage !== "prospect"}
                    />
                  ))}
                  <Cell
                    count={totalDeals}
                    prospects={totals.prospect}
                    showShare={false}
                  />
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
