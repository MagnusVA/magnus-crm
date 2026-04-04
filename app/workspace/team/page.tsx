"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { redirect } from "next/navigation";
import { usePageTitle } from "@/hooks/use-page-title";
import { TeamMembersTable } from "./_components/team-members-table";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DownloadIcon } from "lucide-react";
import { downloadCSV } from "@/lib/export-csv";
import { format } from "date-fns";
import type { Id } from "@/convex/_generated/dataModel";

// Lazy-load dialog components that are only shown on user interaction
const InviteUserDialog = dynamic(() =>
  import("./_components/invite-user-dialog").then((m) => ({
    default: m.InviteUserDialog,
  })),
);
const RemoveUserDialog = dynamic(() =>
  import("./_components/remove-user-dialog").then((m) => ({
    default: m.RemoveUserDialog,
  })),
);
const CalendlyLinkDialog = dynamic(() =>
  import("./_components/calendly-link-dialog").then((m) => ({
    default: m.CalendlyLinkDialog,
  })),
);
const RoleEditDialog = dynamic(() =>
  import("./_components/role-edit-dialog").then((m) => ({
    default: m.RoleEditDialog,
  })),
);

function TableSkeleton() {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex flex-col gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Discriminated union for dialog state ────────────────────────────

type DialogState =
  | { type: null }
  | { type: "remove"; userId: Id<"users">; userName: string }
  | { type: "calendly"; userId: Id<"users">; userName: string }
  | { type: "role"; userId: Id<"users">; userName: string; currentRole: string };

export default function TeamPage() {
  usePageTitle("Team");
  const currentUser = useQuery(api.users.queries.getCurrentUser);
  const isAdmin =
    currentUser?.role === "tenant_master" || currentUser?.role === "tenant_admin";
  const members = useQuery(
    api.users.queries.listTeamMembers,
    isAdmin ? {} : "skip",
  );

  // Single state replaces 12 useState calls
  const [dialog, setDialog] = useState<DialogState>({ type: null });

  const closeDialog = () => setDialog({ type: null });

  const handleEditRole = (memberId: Id<"users">, currentRole: string) => {
    const member = members?.find((m) => m._id === memberId);
    if (member && currentUser && currentUser._id !== memberId && member.role !== "tenant_master") {
      setDialog({
        type: "role",
        userId: memberId,
        userName: member.fullName || member.email,
        currentRole,
      });
    }
  };

  const handleRemoveUser = (memberId: Id<"users">) => {
    const member = members?.find((m) => m._id === memberId);
    if (member && currentUser && currentUser._id !== memberId && member.role !== "tenant_master") {
      setDialog({
        type: "remove",
        userId: memberId,
        userName: member.fullName || member.email,
      });
    }
  };

  const handleRelinkCalendly = (memberId: Id<"users">) => {
    const member = members?.find((m) => m._id === memberId);
    if (member) {
      setDialog({
        type: "calendly",
        userId: memberId,
        userName: member.fullName || member.email,
      });
    }
  };

  if (currentUser === undefined) {
    return <TableSkeleton />;
  }

  if (currentUser === null) {
    return null;
  }

  if (currentUser.role === "closer") {
    redirect("/workspace/closer");
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Team</h1>
          <p className="mt-2 text-muted-foreground">
            Manage your team members and invite new users
          </p>
        </div>
        <div className="flex gap-2">
          {members && members.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                downloadCSV(
                  `team-${format(new Date(), "yyyy-MM-dd")}`,
                  ["Name", "Email", "Role", "Calendly Status"],
                  members.map((m) => [
                    m.fullName ?? "",
                    m.email,
                    m.role.replace(/_/g, " "),
                    m.calendlyMemberName ?? "Not linked",
                  ]),
                );
              }}
            >
              <DownloadIcon data-icon="inline-start" />
              Export CSV
            </Button>
          )}
          <InviteUserDialog />
        </div>
      </div>

      {members === undefined || currentUser === undefined ? (
        <TableSkeleton />
      ) : (
        <TeamMembersTable
          members={members}
          currentUserId={currentUser?._id}
          onEditRole={handleEditRole}
          onRemoveUser={handleRemoveUser}
          onRelinkCalendly={handleRelinkCalendly}
        />
      )}

      {/* Dialogs — render based on discriminated union */}
      {dialog.type === "remove" && (
        <RemoveUserDialog
          open
          onOpenChange={(open) => {
            if (!open) closeDialog();
          }}
          userId={dialog.userId}
          userName={dialog.userName}
        />
      )}

      {dialog.type === "calendly" && (
        <CalendlyLinkDialog
          open
          onOpenChange={(open) => {
            if (!open) closeDialog();
          }}
          userId={dialog.userId}
          userName={dialog.userName}
        />
      )}

      {dialog.type === "role" && (
        <RoleEditDialog
          open
          onOpenChange={(open) => {
            if (!open) closeDialog();
          }}
          userId={dialog.userId}
          userName={dialog.userName}
          currentRole={dialog.currentRole}
        />
      )}
    </div>
  );
}
