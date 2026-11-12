"use client";

import { useState } from "react";
import Link from "next/link";
import {
  useConvex,
  useMutation,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/app/workspace/closer/_components/today-time";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";

type Manifest = FunctionReturnType<typeof api.pipeline.recovery.preview>;
type HeldBooking = FunctionReturnType<typeof api.pipeline.heldBookings.list>["page"][number];

const VIA_WORDS = { email: "email", phone: "phone", social_handle: "Instagram" } as const;

/**
 * One held or failed booking as a person reads it: who booked, when the call
 * is, the closer, what matched, why it's held and the next step, and the
 * actions that can help. The receipt ID is last, for an operator.
 */
function HeldBookingCard({
  row,
  busy,
  onRetry,
}: {
  row: HeldBooking;
  busy: boolean;
  onRetry: (id: Id<"webhookDeliveries">) => void;
}) {
  const { setting } = useBusinessDay();
  const now = useNow();
  const past = row.startTime !== undefined && row.startTime < now;
  const actions = new Set(row.explanation.actions);
  return (
    <li className="flex flex-col gap-2 py-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[15px] font-semibold">{row.inviteeName ?? "Unnamed invitee"}</p>
        <span className={past ? "text-xs font-medium text-warning-ink" : "text-xs font-medium text-muted-foreground"}>
          {row.startTime === undefined ? "Call time unknown" : past ? "Call already happened" : "Call upcoming"}
          {row.canceledAt !== undefined ? " · canceled in Calendly" : ""}
        </span>
      </div>
      <p className="text-muted-foreground">
        {[
          row.eventName,
          row.startTime !== undefined ? formatDateTime(row.startTime, setting.timeZone) : null,
          row.closerName ? `Closer: ${row.closerName}` : row.hostName ? `Host: ${row.hostName} (not linked to a closer)` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border p-2.5">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What was typed</p>
          <p className="break-all">{row.email ?? "No email"}</p>
          <p>{row.phone ?? "No phone"}</p>
        </div>
        <div className="rounded-md border p-2.5">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Who matched</p>
          {row.matches.length ? (
            <ul>
              {row.matches.map((match) => (
                <li key={match.leadId}>
                  <Link href={`/workspace/leads/${match.leadId}`} className="underline underline-offset-2">
                    {match.name ?? "Unnamed person"}
                  </Link>{" "}
                  <span className="text-muted-foreground">by {match.via.map((via) => VIA_WORDS[via]).join(" and ")}</span>
                </li>
              ))}
              {row.matchesTruncated ? <li className="text-muted-foreground">and more</li> : null}
            </ul>
          ) : (
            <p className="text-muted-foreground">No one, or not recorded for this hold</p>
          )}
        </div>
      </div>
      <p>{row.explanation.cause}</p>
      <p className="border-l-2 border-primary pl-2.5 font-medium">{row.explanation.nextStep}</p>
      <div className="flex flex-wrap gap-2">
        {row.reviewId && (actions.has("open_review") || row.reviewOpen) ? (
          <Button asChild size="sm">
            <Link href={`/workspace/operations/booking-reviews/${row.reviewId}`}>Open review</Link>
          </Button>
        ) : null}
        {actions.has("link_host") ? (
          <Button asChild size="sm" variant="outline">
            <Link href="/workspace/team">Link host</Link>
          </Button>
        ) : null}
        {actions.has("retry") || !row.explanation.actions.length || row.explanation.needsOperator ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !row.payloadAvailable}
            onClick={() => onRetry(row.deliveryId)}
          >
            Retry
          </Button>
        ) : null}
      </div>
      <p className="font-mono text-xs text-muted-foreground">
        Receipt {row.deliveryId} · {row.reason ?? "no reason"} · tried {row.generation} time{row.generation === 1 ? "" : "s"}
        {row.waitingOnDeliveryId ? ` · waits on ${row.waitingOnDeliveryId}` : ""}
        {row.payloadAvailable ? "" : " · original data gone"}
      </p>
    </li>
  );
}
export function PipelineRecoveryPanel() {
  const client = useConvex();
  const retry = useMutation(api.pipeline.recovery.retry);
  const retryReport = useMutation(api.operations.workStatus.retry);
  const health = useQuery(api.operations.workStatus.health, {});
  const [status, setStatus] = useState<"blocked" | "failed">("blocked");
  const [kind, setKind] = useState<"meeting" | "opportunity">("meeting");
  const deliveries = usePaginatedQuery(
    api.pipeline.heldBookings.list,
    { status },
    { initialNumItems: 25 },
  );
  const reports = usePaginatedQuery(
    api.operations.workStatus.list,
    { kind, status: "failed" },
    { initialNumItems: 25 },
  );
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function review(id: Id<"webhookDeliveries">) {
    setBusy(true);
    setError(null);
    try {
      setManifest(
        await client.query(api.pipeline.recovery.preview, {
          deliveryIds: [id],
        }),
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not load recovery preview",
      );
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!manifest) return;
    setBusy(true);
    setError(null);
    try {
      await retry({ manifest });
      setManifest(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Booking and reporting recovery</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Each held booking says why the CRM is holding it and what to do
          next. Retries check current records and preserve payments and
          completed outcomes.
        </p>
        <ul className="text-sm">
          {health?.queues
            .filter((q) => q.count > 0)
            .map((q) => (
              <li key={q.kind}>
                {q.kind.replaceAll(":", " — ")}: {q.count}
                {q.capped ? "+" : ""}
                {q.oldestRequestedAt !== undefined
                  ? ` · oldest ${new Date(q.oldestRequestedAt).toLocaleString()}`
                  : ""}
              </li>
            ))}
        </ul>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          {(["blocked", "failed"] as const).map((value) => (
            <Button
              key={value}
              variant={status === value ? "default" : "outline"}
              size="sm"
              onClick={() => setStatus(value)}
            >
              {value === "blocked"
                ? "Bookings held for review"
                : "Failed deliveries"}
            </Button>
          ))}
        </div>
        <ul className="divide-y">
          {deliveries.results.map((row) => (
            <HeldBookingCard
              key={row.deliveryId}
              row={row}
              busy={busy}
              onRetry={(id) => void review(id)}
            />
          ))}
          {deliveries.status === "Exhausted" && deliveries.results.length === 0 ? (
            <li className="py-3 text-sm text-muted-foreground">
              {status === "blocked" ? "No bookings are held." : "No deliveries failed."}
            </li>
          ) : null}
        </ul>
        {deliveries.status === "CanLoadMore" && (
          <Button variant="outline" onClick={() => deliveries.loadMore(25)}>
            Load more deliveries
          </Button>
        )}
        {manifest && (
          <div className="space-y-3 rounded-md border p-4 text-sm">
            <p>
              Retry {manifest[0].eventType} from{" "}
              {new Date(manifest[0].occurredAt).toLocaleString()}?
            </p>
            <p>
              {manifest[0].rawAvailable
                ? "The original payload is available. Current identity and booking checks will run again."
                : "The original payload is unavailable; this delivery cannot be retried."}
            </p>
            <div className="flex gap-2">
              <Button
                disabled={busy || !manifest[0].rawAvailable}
                onClick={() => void apply()}
              >
                Retry delivery
              </Button>
              <Button variant="outline" onClick={() => setManifest(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        <div className="flex gap-2">
          {(["meeting", "opportunity"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={kind === value ? "default" : "outline"}
              onClick={() => setKind(value)}
            >
              Failed {value} reports
            </Button>
          ))}
        </div>
        <ul className="divide-y">
          {reports.results.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-3 py-3 text-sm"
            >
              <div>
                <p>{row.reason?.replaceAll("_", " ")}</p>
                <p className="font-mono text-xs">{row.sourceId}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await retryReport({
                      kind,
                      id: row.id,
                      generation: row.generation,
                    });
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Retry failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Retry report
              </Button>
            </li>
          ))}
        </ul>
        {reports.status === "CanLoadMore" && (
          <Button variant="outline" onClick={() => reports.loadMore(25)}>
            Load more reports
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
