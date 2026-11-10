"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useMutation, usePreloadedQuery, type Preloaded } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { AlertCircleIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CARD, CardHead, plural } from "@/app/workspace/team/_components/team-ui";
import { NoteLine, StatusWord, type Tone } from "@/app/workspace/settings/_components/settings-ui";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { useHydrated } from "@/hooks/use-hydrated";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { getErrorMessage } from "@/lib/errors";

type PlanView = NonNullable<FunctionReturnType<typeof api.mcp.approvals.getPlan>>;

/** What `applyPrepared` and `declinePlan` store; read loosely, it's `v.any()`. */
type Outcome = {
  status?: string;
  message?: unknown;
  changed?: unknown;
  openInMagnus?: unknown;
} | null;

const STATUS: Record<string, { word: string; tone: Tone }> = {
  waiting: { word: "Waiting", tone: "muted" },
  applied: { word: "Applied", tone: "ok" },
  stale: { word: "Not applied", tone: "warning" },
  refused: { word: "Refused", tone: "danger" },
  declined: { word: "Declined", tone: "muted" },
};

const TIME = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * The in-app path a plan cell points to, or null. Cells are agent-shaped
 * text, so only a `/workspace/...` path (bare, or as an absolute http(s)
 * URL) becomes a link, and it always opens inside Magnus.
 */
function appPath(cell: string): string | null {
  const text = cell.trim();
  const bare = /^\/workspace\/[\w\-./?=&%]*$/.test(text);
  if (!bare && !/^https?:\/\//i.test(text)) return null;
  try {
    // Resolves "." and ".." first, so the path checked is the one opened.
    const url = new URL(text, "https://magnus.invalid");
    return url.pathname.startsWith("/workspace/") ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

export function ApprovalPageClient({
  planId,
  preloadedPlan,
}: {
  planId: string;
  preloadedPlan: Preloaded<typeof api.mcp.approvals.getPlan>;
}) {
  const plan = usePreloadedQuery(preloadedPlan);
  usePageTitle(plan ? plan.title : "Approval");
  useBreadcrumbTrail([
    { label: "AI assistant", href: "/workspace/profile" },
    { label: "Approval", href: `/workspace/assistant/approvals/${planId}` },
  ]);

  if (!plan) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertCircleIcon />
            </EmptyMedia>
            <EmptyTitle>Plan not found</EmptyTitle>
            <EmptyDescription>This plan doesn&apos;t exist or isn&apos;t yours to see.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return <PlanDetail plan={plan} />;
}

function PlanDetail({ plan }: { plan: PlanView }) {
  const hydrated = useHydrated();
  const now = useNow();
  const status = STATUS[plan.status] ?? { word: plan.status, tone: "muted" as Tone };
  const decided = plan.status !== "waiting";
  const expired = !decided && hydrated && plan.expiresAt < now;
  const when = (time: number) => (hydrated ? TIME.format(time) : "…");

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] text-muted-foreground">{plan.familyLabel} · Prepared by an AI assistant</p>
          <h1 className="text-2xl font-semibold tracking-tight break-words">{plan.title}</h1>
          <p className="text-sm text-muted-foreground">
            {plan.preparedBy} with {plan.agentClient ?? "an AI assistant"} · {when(plan.createdAt)}
          </p>
        </div>
        <StatusWord tone={expired ? "warning" : status.tone} className="mt-1">
          {expired ? "Expired" : status.word}
        </StatusWord>
      </header>

      <section aria-label="What will change" className={CARD}>
        <CardHead title="What will change" meta={plural(plan.rows.length, "row")} />
        {plan.summary ? (
          <div className="border-b border-border px-4 py-2.5">
            <p className="text-sm whitespace-pre-wrap break-words">{plan.summary}</p>
          </div>
        ) : null}
        {plan.rows.length ? (
          <PlanTable columns={plan.columns} rows={plan.rows} />
        ) : (
          <div className="px-4 py-2.5">
            <NoteLine>No rows.</NoteLine>
          </div>
        )}
        {plan.footnote ? (
          <div className="border-t border-border px-4 py-2.5">
            <NoteLine className="whitespace-pre-wrap break-words">{plan.footnote}</NoteLine>
          </div>
        ) : null}
      </section>

      {decided ? (
        <OutcomePanel status={plan.status} outcome={plan.outcome as Outcome} />
      ) : (
        <Decision plan={plan} expiresAt={when(plan.expiresAt)} expired={expired} />
      )}
    </div>
  );
}

function PlanTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <Table>
      {columns.length ? (
        <TableHeader>
          <TableRow>
            {columns.map((column, index) => (
              <TableHead key={index} className="px-4">
                {column}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
      ) : null}
      <TableBody>
        {rows.map((row, rowIndex) => (
          <TableRow key={rowIndex}>
            {row.map((cell, cellIndex) => {
              const path = appPath(cell);
              return (
                <TableCell key={cellIndex} className="px-4 align-top whitespace-normal break-words">
                  {path ? (
                    <Link
                      href={path}
                      className="font-medium underline underline-offset-[3px]"
                      aria-label={row[0] && cellIndex !== 0 ? `Open ${row[0]} in Magnus` : "Open in Magnus"}
                    >
                      Open
                    </Link>
                  ) : (
                    cell
                  )}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Approve and Decline while the plan waits, or why this person can't. */
function Decision({ plan, expiresAt, expired }: { plan: PlanView; expiresAt: string; expired: boolean }) {
  const approvePlan = useMutation(api.mcp.approvals.approvePlan);
  const declinePlan = useMutation(api.mcp.approvals.declinePlan);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<null | "approve" | "decline">(null);
  // A ref as well as state: two clicks in one frame both see the old state.
  const busy = useRef(false);

  async function run(kind: "approve" | "decline") {
    if (busy.current) return;
    busy.current = true;
    setPending(kind);
    try {
      if (kind === "approve") {
        const result = (await approvePlan({ planId: plan.planId })) as Outcome;
        setConfirming(false);
        if (result?.status === "applied") toast.success("Approved. Magnus made the change.");
        else toast.warning("Magnus didn't apply this change. The reason is below.");
      } else {
        await declinePlan({ planId: plan.planId });
        toast.success("Declined. Nothing was changed.");
      }
    } catch (error) {
      setConfirming(false);
      toast.error(getErrorMessage(error, kind === "approve" ? "Couldn't approve this change." : "Couldn't decline this change."));
    } finally {
      busy.current = false;
      setPending(null);
    }
  }

  if (!plan.canApprove) {
    return (
      <section aria-label="Decision" className={CARD}>
        <div className="px-4 py-3">
          <NoteLine tone="warning" role="status">
            {plan.reason ?? "You can't approve this change."}
          </NoteLine>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Decision" className={CARD}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <NoteLine className="mr-auto">
          {expired ? "This plan has expired." : `Expires ${expiresAt}. Nothing changes until you approve.`}
        </NoteLine>
        <Button variant="outline" disabled={pending !== null} onClick={() => void run("decline")}>
          {pending === "decline" ? "Declining…" : "Decline"}
        </Button>
        <Button disabled={pending !== null || expired} onClick={() => setConfirming(true)}>
          Approve
        </Button>
      </div>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && pending === null) setConfirming(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve this change?</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-wrap break-words">
              {plan.summary || plan.title}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <NoteLine>
            Magnus applies it now, as {plan.preparedBy}&apos;s assistant prepared it. If any record changed since, Magnus
            applies nothing and says so.
          </NoteLine>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending !== null}
              onClick={(event) => {
                event.preventDefault();
                void run("approve");
              }}
            >
              {pending === "approve" ? "Applying…" : "Approve and apply"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** What happened once the plan was decided. */
function OutcomePanel({ status, outcome }: { status: string; outcome: Outcome }) {
  const message = typeof outcome?.message === "string" ? outcome.message : null;
  const changed = Array.isArray(outcome?.changed) ? outcome.changed.length : 0;
  const link = typeof outcome?.openInMagnus === "string" ? appPath(outcome.openInMagnus) : null;
  const text =
    status === "applied"
      ? "Applied. Magnus made the change."
      : status === "stale"
        ? `Nothing was changed: ${plural(changed || 1, "record")} changed after this was prepared. Ask your assistant to prepare it again.`
        : status === "refused"
          ? `Nothing was changed. ${message ?? "Magnus refused this change."}`
          : status === "declined"
            ? "Declined. Nothing was changed."
            : `This plan is ${status}.`;
  const tone: Tone = status === "applied" || status === "declined" ? "ok" : status === "refused" ? "danger" : "warning";

  return (
    <section aria-label="Outcome" className={CARD}>
      <CardHead title="Outcome">
        <StatusWord tone={STATUS[status]?.tone ?? "muted"}>{STATUS[status]?.word ?? status}</StatusWord>
      </CardHead>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <NoteLine tone={tone} role="status" className="mr-auto">
          {text}
        </NoteLine>
        {link ? (
          <Button asChild variant="outline" size="sm">
            <Link href={link}>Open in Magnus</Link>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
