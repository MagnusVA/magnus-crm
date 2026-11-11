"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { OpinionChip } from "@/components/second-opinion/meeting-card";
import {
  heardLabel,
  localDate,
  recordLabel,
} from "@/components/second-opinion/presentation";
import { usePageTitle } from "@/hooks/use-page-title";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { SecondOpinionsSkeleton } from "./second-opinions-skeleton";
type Tab = "disagrees" | "unsure" | "checked" | "all";
export function SecondOpinionsPageClient() {
  usePageTitle("Second opinions");
  useBreadcrumbTrail([
    { label: "Pipeline", href: "/workspace/pipeline" },
    { label: "Second opinions", href: "/workspace/pipeline/second-opinions" },
  ]);
  const [tab, setTab] = useState<Tab>("disagrees");
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const result = useQuery(api.secondOpinion.listForReview, {
    tab,
    paginationOpts: { numItems: 25, cursor: cursors.at(-1) ?? null },
  });
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Second opinions
        </h1>
        <p className="text-sm text-muted-foreground">
          Recorded calls Jev checked
        </p>
      </header>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value as Tab);
          setCursors([null]);
        }}
      >
        <TabsList>
          <TabsTrigger value="disagrees">Disagree</TabsTrigger>
          <TabsTrigger value="unsure">Not sure</TabsTrigger>
          <TabsTrigger value="checked">Checked</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>
      {!result ? (
        <SecondOpinionsSkeleton />
      ) : !result.visible ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>The second opinion is off.</EmptyTitle>
            <EmptyDescription>
              An owner can turn it on in Settings → Integrations → Fathom.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {tab === "all"
                ? "All checks"
                : tab === "checked"
                  ? "Checked by an admin"
                  : tab === "unsure"
                    ? "Not sure"
                    : "Disagreements to check"}
            </CardTitle>
            <CardDescription>
              Each check keeps the record as it was when Jev ran.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Checked</TableHead>
                  <TableHead>Call</TableHead>
                  <TableHead>Recorded</TableHead>
                  <TableHead>Program</TableHead>
                  <TableHead>Jev heard</TableHead>
                  <TableHead>
                    <span className="sr-only">Review</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.page.map((detail) => (
                  <TableRow key={detail.opinion._id}>
                    <TableCell className="text-muted-foreground">
                      {localDate(
                        detail.opinion.answeredAt ?? detail.opinion.createdAt,
                        detail.timeZone,
                      )}
                    </TableCell>
                    <TableCell>
                      <Link
                        className="font-medium underline-offset-4 hover:underline"
                        href={`/workspace/pipeline/second-opinions/${detail.opinion._id}`}
                      >
                        {detail.person}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {detail.closer} ·{" "}
                        {localDate(detail.scheduledAt, detail.timeZone)}
                      </p>
                    </TableCell>
                    <TableCell>{recordLabel(detail.opinion.record)}</TableCell>
                    <TableCell>{detail.program ?? "—"}</TableCell>
                    <TableCell>
                      <p>{heardLabel(detail.opinion)}</p>
                      <OpinionChip detail={detail} />
                    </TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" asChild>
                        <Link
                          href={`/workspace/pipeline/second-opinions/${detail.opinion._id}`}
                        >
                          Open
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {result.page.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>Nothing to check right now.</EmptyTitle>
                        </EmptyHeader>
                      </Empty>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
          <CardFooter className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              This month{result.month.capped ? " · partial totals" : ""} ·{" "}
              {result.month.answered} calls checked · {result.month.disagrees}{" "}
              disagree · {result.month.unsure} not sure · {result.month.checked}{" "}
              checked by an admin
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={cursors.length === 1}
                onClick={() => setCursors((previous) => previous.slice(0, -1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={result.isDone}
                onClick={() =>
                  setCursors((previous) => [...previous, result.continueCursor])
                }
              >
                Next
              </Button>
            </div>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
