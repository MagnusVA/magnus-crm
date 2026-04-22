"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import posthog from "posthog-js";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisVerticalIcon,
  PencilIcon,
} from "lucide-react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { ProgramFormDialog } from "./program-form-dialog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProgramRowData = {
  _id: Id<"tenantPrograms">;
  name: string;
  description?: string;
  defaultCurrency?: string;
  archivedAt?: number;
};

interface ProgramRowProps {
  program: ProgramRowData;
}

type PendingAction = null | "archive" | "restore";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProgramRow({ program }: ProgramRowProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const archiveProgram = useMutation(
    api.tenantPrograms.mutations.archiveProgram,
  );
  const restoreProgram = useMutation(
    api.tenantPrograms.mutations.restoreProgram,
  );

  const isArchived = !!program.archivedAt;

  const handleConfirm = async () => {
    if (!pendingAction) return;
    setIsSubmitting(true);
    try {
      if (pendingAction === "archive") {
        await archiveProgram({ programId: program._id });
        posthog.capture("program_archived", { programId: program._id });
        toast.success(`"${program.name}" archived`);
      } else {
        await restoreProgram({ programId: program._id });
        posthog.capture("program_restored", { programId: program._id });
        toast.success(`"${program.name}" restored`);
      }
      setPendingAction(null);
    } catch (error) {
      posthog.captureException(error);
      // Surface the server-side reason verbatim when available — the
      // archive / restore mutations throw actionable errors (e.g.
      // "At least one active program is required. Create or restore
      // another program before archiving this one.") and replacing them
      // with a generic message hides the actual blocker from the admin.
      const fallback =
        pendingAction === "archive"
          ? "Cannot archive — at least one active program must remain."
          : "Cannot restore — a program with this name already exists.";
      const message =
        error instanceof Error && error.message
          ? error.message
          : fallback;
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Card className={cn(isArchived && "opacity-70")}>
        <CardContent className="flex items-start justify-between gap-4 py-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-medium">{program.name}</p>
              {program.defaultCurrency && (
                <Badge variant="outline" className="shrink-0">
                  {program.defaultCurrency}
                </Badge>
              )}
              {isArchived && (
                <Badge variant="secondary" className="shrink-0">
                  Archived
                </Badge>
              )}
            </div>
            {program.description && (
              <p className="line-clamp-2 text-sm text-muted-foreground">
                {program.description}
              </p>
            )}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Actions for ${program.name}`}
              >
                <EllipsisVerticalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <PencilIcon data-icon="inline-start" />
                Edit
              </DropdownMenuItem>
              {!isArchived && (
                <DropdownMenuItem
                  onClick={() => setPendingAction("archive")}
                  variant="destructive"
                >
                  <ArchiveIcon data-icon="inline-start" />
                  Archive
                </DropdownMenuItem>
              )}
              {isArchived && (
                <DropdownMenuItem
                  onClick={() => setPendingAction("restore")}
                >
                  <ArchiveRestoreIcon data-icon="inline-start" />
                  Restore
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </CardContent>
      </Card>

      <ProgramFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        program={program}
      />

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(next) => {
          if (!next && !isSubmitting) setPendingAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction === "archive"
                ? `Archive ${program.name}?`
                : `Restore ${program.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction === "archive"
                ? "Archived programs are hidden from new customer and payment dialogs but remain visible in reports. You can restore at any time."
                : "This program will reappear in customer and payment dialogs."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Prevent shadcn's auto-close; we close manually once the
                // mutation settles (so the Spinner stays visible and we can
                // surface errors via toast without a race).
                event.preventDefault();
                void handleConfirm();
              }}
              disabled={isSubmitting}
              className={cn(
                pendingAction === "archive" &&
                  "bg-destructive text-destructive-foreground hover:bg-destructive/90",
              )}
            >
              {isSubmitting && <Spinner data-icon="inline-start" />}
              {pendingAction === "archive" ? "Archive" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
