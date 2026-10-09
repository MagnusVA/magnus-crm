"use client";

import { useState } from "react";
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

type Manifest = FunctionReturnType<typeof api.pipeline.recovery.preview>;
export function PipelineRecoveryPanel() {
  const client = useConvex();
  const retry = useMutation(api.pipeline.recovery.retry);
  const retryReport = useMutation(api.operations.workStatus.retry);
  const health = useQuery(api.operations.workStatus.health, {});
  const [status, setStatus] = useState<"blocked" | "failed">("blocked");
  const [kind, setKind] = useState<"meeting" | "opportunity">("meeting");
  const deliveries = usePaginatedQuery(
    api.pipeline.delivery.list,
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
          Correct the host link or identity conflict before retrying. Retries
          check current records and preserve payments and completed outcomes.
          Ambiguous historical bookings remain held for review.
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
            <li
              key={row._id}
              className="flex items-center justify-between gap-3 py-3 text-sm"
            >
              <div>
                <p>
                  {row.eventType} · {new Date(row.occurredAt).toLocaleString()}
                </p>
                <p className="text-muted-foreground">
                  {row.reason?.replaceAll("_", " ")}
                </p>
                <p className="font-mono text-xs">{row._id}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void review(row._id)}
              >
                Review retry
              </Button>
            </li>
          ))}
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
