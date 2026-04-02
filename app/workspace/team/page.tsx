"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { TeamMembersTable } from "./_components/team-members-table";
import { InviteUserDialog } from "./_components/invite-user-dialog";
import { RemoveUserDialog } from "./_components/remove-user-dialog";
import { CalendlyLinkDialog } from "./_components/calendly-link-dialog";
import { RoleEditDialog } from "./_components/role-edit-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import type { Id } from "@/convex/_generated/dataModel";

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

export default function TeamPage() {
  const members = useQuery(api.users.queries.listTeamMembers);

  // Remove user dialog state
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removeUserId, setRemoveUserId] = useState<Id<"users"> | null>(null);
  const [removeUserName, setRemoveUserName] = useState("");

  // Calendly link dialog state
  const [calendlyDialogOpen, setCalendlyDialogOpen] = useState(false);
  const [calendlyUserId, setCalendlyUserId] = useState<Id<"users"> | null>(
    null,
  );
  const [calendlyUserName, setCalendlyUserName] = useState("");

  // Role edit dialog state
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [roleUserId, setRoleUserId] = useState<Id<"users"> | null>(null);
  const [roleUserName, setRoleUserName] = useState("");
  const [roleCurrentRole, setRoleCurrentRole] = useState<string>("");

  const handleEditRole = (memberId: Id<"users">, currentRole: string) => {
    const member = members?.find((m) => m._id === memberId);
    if (member) {
      setRoleUserId(memberId);
      setRoleUserName(member.fullName || member.email);
      setRoleCurrentRole(currentRole);
      setRoleDialogOpen(true);
    }
  };

  const handleRemoveUser = (memberId: Id<"users">) => {
    const member = members?.find((m) => m._id === memberId);
    if (member) {
      setRemoveUserId(memberId);
      setRemoveUserName(member.fullName || member.email);
      setRemoveDialogOpen(true);
    }
  };

  const handleRelinkCalendly = (memberId: Id<"users">) => {
    const member = members?.find((m) => m._id === memberId);
    if (member) {
      setCalendlyUserId(memberId);
      setCalendlyUserName(member.fullName || member.email);
      setCalendlyDialogOpen(true);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Team</h1>
          <p className="mt-2 text-muted-foreground">
            Manage your team members and invite new users
          </p>
        </div>
        <InviteUserDialog />
      </div>

      {members === undefined ? (
        <TableSkeleton />
      ) : (
        <TeamMembersTable
          members={members}
          onEditRole={handleEditRole}
          onRemoveUser={handleRemoveUser}
          onRelinkCalendly={handleRelinkCalendly}
        />
      )}

      {/* Remove User Dialog */}
      {removeUserId && (
        <RemoveUserDialog
          open={removeDialogOpen}
          onOpenChange={setRemoveDialogOpen}
          userId={removeUserId}
          userName={removeUserName}
        />
      )}

      {/* Calendly Link Dialog */}
      {calendlyUserId && (
        <CalendlyLinkDialog
          open={calendlyDialogOpen}
          onOpenChange={setCalendlyDialogOpen}
          userId={calendlyUserId}
          userName={calendlyUserName}
        />
      )}

      {/* Role Edit Dialog */}
      {roleUserId && (
        <RoleEditDialog
          open={roleDialogOpen}
          onOpenChange={setRoleDialogOpen}
          userId={roleUserId}
          userName={roleUserName}
          currentRole={roleCurrentRole}
        />
      )}
    </div>
  );
}
