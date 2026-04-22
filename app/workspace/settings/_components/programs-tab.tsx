"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { ArchiveIcon, Package } from "lucide-react";

import { api } from "@/convex/_generated/api";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

import { ProgramFormDialog } from "./program-form-dialog";
import { ProgramRow } from "./program-row";

export function ProgramsTab() {
  // Explicit user preference for whether archived programs are visible.
  // `showArchivedEffective` below may override this to `true` when every
  // program is archived, so the admin can actually see (and restore) one.
  const [showArchivedExplicit, setShowArchivedExplicit] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
    includeArchived: true,
  });

  const isLoading = programs === undefined;
  const activePrograms = programs?.filter((p) => !p.archivedAt) ?? [];
  const archivedPrograms = programs?.filter((p) => !!p.archivedAt) ?? [];
  const isEmpty = !isLoading && (programs?.length ?? 0) === 0;
  // "All programs archived" — tenant had programs historically but none are
  // active right now. Payment flows break in this state because every payment
  // dialog requires an active program. Surface a dedicated callout and
  // auto-show the archived list so the admin can restore one quickly.
  const allArchived =
    !isLoading &&
    activePrograms.length === 0 &&
    archivedPrograms.length > 0;
  // Derived visibility — user preference OR forced-on when everything is
  // archived. No `useEffect` sync needed: the Switch reflects the effective
  // state and is disabled while the override is active.
  const showArchived = showArchivedExplicit || allArchived;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">Programs</h2>
          <p className="text-sm text-muted-foreground">
            Define the services or packages you sell. Programs tag payments
            for reporting and are shown in customer views.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="show-archived-programs"
              checked={showArchived}
              onCheckedChange={setShowArchivedExplicit}
              disabled={allArchived}
              aria-describedby={
                allArchived ? "show-archived-forced-hint" : undefined
              }
            />
            <Label
              htmlFor="show-archived-programs"
              className="text-sm font-normal"
            >
              Show archived
            </Label>
          </div>
          <Button onClick={() => setCreateOpen(true)}>Create Program</Button>
        </div>
      </div>

      {isLoading && (
        <div
          className="flex flex-col gap-3"
          role="status"
          aria-label="Loading programs"
        >
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      )}

      {isEmpty && (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <Package className="size-6 text-muted-foreground" />
            </div>
            <div className="flex flex-col gap-1.5">
              <h3 className="text-base font-semibold">No programs yet</h3>
              <p className="max-w-md text-sm text-muted-foreground">
                Create your first program to start attributing payments. You
                must have at least one active program before recording
                payments.
              </p>
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              Create Your First Program
            </Button>
          </CardContent>
        </Card>
      )}

      {allArchived && (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-amber-500/10">
              <ArchiveIcon className="size-6 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex flex-col gap-1.5">
              <h3 className="text-base font-semibold">
                All programs are archived
              </h3>
              <p className="max-w-md text-sm text-muted-foreground">
                Payments cannot be recorded without at least one active program.
                Restore an archived program below or create a new one to resume
                payment entry.
              </p>
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              Create New Program
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isEmpty && (
        <div className="flex flex-col gap-6">
          {activePrograms.length > 0 && (
            <section className="flex flex-col gap-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Active
              </h3>
              <div className="flex flex-col gap-3">
                {activePrograms.map((program) => (
                  <ProgramRow key={program._id} program={program} />
                ))}
              </div>
            </section>
          )}

          {showArchived && archivedPrograms.length > 0 && (
            <section className="flex flex-col gap-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Archived
              </h3>
              <div className="flex flex-col gap-3">
                {archivedPrograms.map((program) => (
                  <ProgramRow key={program._id} program={program} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <ProgramFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
