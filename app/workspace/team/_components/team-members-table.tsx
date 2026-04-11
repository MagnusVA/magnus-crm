"use client";

import { useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { SortableHeader } from "@/components/sortable-header";
import { RequirePermission } from "@/components/auth/require-permission";
import {
  EllipsisVerticalIcon,
  AlertCircleIcon,
  Link2Icon,
  ShieldIcon,
  Trash2Icon,
  UsersIcon,
  CalendarPlusIcon,
  CalendarOffIcon,
} from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { useTableSort } from "@/hooks/use-table-sort";

interface TeamMember {
  _id: Id<"users">;
  _creationTime: number;
  email: string;
  fullName?: string;
  role: "closer" | "tenant_admin" | "tenant_master";
  calendlyMemberName?: string;
  calendlyUserUri?: string;
  personalEventTypeUri?: string;
}

interface TeamMembersTableProps {
  members: TeamMember[];
  currentUserId?: Id<"users">;
  onEditRole?: (memberId: Id<"users">, currentRole: string) => void;
  onRemoveUser?: (memberId: Id<"users">) => void;
  onRelinkCalendly?: (memberId: Id<"users">) => void;
  onAssignEventType?: (memberId: Id<"users">) => void;
  onMarkUnavailable?: (memberId: Id<"users">) => void;
}

const roleLabels: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
  closer: { label: "Closer", variant: "default" },
  tenant_admin: { label: "Admin", variant: "secondary" },
  tenant_master: { label: "Owner", variant: "outline" },
};

export function TeamMembersTable({
  members,
  currentUserId,
  onEditRole,
  onRemoveUser,
  onRelinkCalendly,
  onAssignEventType,
  onMarkUnavailable,
}: TeamMembersTableProps) {
  const comparators = useMemo(() => ({
    name: (a: TeamMember, b: TeamMember) => (a.fullName ?? a.email).localeCompare(b.fullName ?? b.email),
    email: (a: TeamMember, b: TeamMember) => a.email.localeCompare(b.email),
    role: (a: TeamMember, b: TeamMember) => a.role.localeCompare(b.role),
    calendly: (a: TeamMember, b: TeamMember) => (a.calendlyMemberName ?? "").localeCompare(b.calendlyMemberName ?? ""),
    personalEventType: (a: TeamMember, b: TeamMember) => (a.personalEventTypeUri ?? "").localeCompare(b.personalEventTypeUri ?? ""),
  }), []);

  const { sorted, sort, toggle } = useTableSort(members, comparators);
  if (members.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersIcon />
          </EmptyMedia>
          <EmptyTitle>No team members yet</EmptyTitle>
          <EmptyDescription>
            Use the &ldquo;Invite User&rdquo; button above to invite your first team member and get started.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHeader
              label="Name"
              sortKey="name"
              sort={sort}
              onToggle={toggle}
            />
            <SortableHeader
              label="Email"
              sortKey="email"
              sort={sort}
              onToggle={toggle}
            />
            <SortableHeader
              label="Role"
              sortKey="role"
              sort={sort}
              onToggle={toggle}
            />
            <SortableHeader
              label="Calendly Status"
              sortKey="calendly"
              sort={sort}
              onToggle={toggle}
            />
            <SortableHeader
              label="Personal Event Type"
              sortKey="personalEventType"
              sort={sort}
              onToggle={toggle}
            />
            <TableHead className="text-right font-semibold">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((member) => {
            const role = roleLabels[member.role] ?? {
              label: member.role,
              variant: "secondary" as const,
            };
            const isCloserWithoutCalendly =
              member.role === "closer" && !member.calendlyUserUri;

            const isSelf = currentUserId === member._id;
            const isOwner = member.role === "tenant_master";
            const canEditRole = onEditRole && !isSelf && !isOwner;
            const canRemove = onRemoveUser && !isSelf && !isOwner;
            const canRelinkCalendly =
              member.role === "closer" && onRelinkCalendly;
            const canAssignEventType =
              member.role === "closer" && onAssignEventType;
            const canMarkUnavailable =
              member.role === "closer" && onMarkUnavailable;
            const hasAnyAction = canEditRole || canRemove || canRelinkCalendly || canAssignEventType || canMarkUnavailable;

            return (
              <TableRow key={member._id}>
                <TableCell className="font-medium">
                  {member.fullName || member.email}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {member.email}
                </TableCell>
                <TableCell>
                  <Badge variant={role.variant}>{role.label}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {member.calendlyMemberName ? (
                      <span className="text-sm text-muted-foreground">
                        {member.calendlyMemberName}
                      </span>
                    ) : member.role === "closer" ? (
                      <>
                        <AlertCircleIcon className="size-4 text-amber-600 dark:text-amber-400" />
                        <span className="text-sm text-amber-600 dark:text-amber-400">
                          Not linked
                        </span>
                      </>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  {member.role === "closer" ? (
                    member.personalEventTypeUri ? (
                      <span className="block max-w-[200px] truncate text-sm text-muted-foreground">
                        {member.personalEventTypeUri}
                      </span>
                    ) : (
                      <span className="text-sm text-amber-600 dark:text-amber-400">
                        Not assigned
                      </span>
                    )
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {hasAnyAction ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-8 p-0"
                          aria-label={`Actions for ${member.fullName || member.email}`}
                        >
                          <EllipsisVerticalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuGroup>
                          {canRelinkCalendly && (
                            <DropdownMenuItem
                              onClick={() => onRelinkCalendly(member._id)}
                            >
                              <Link2Icon data-icon="inline-start" />
                              {isCloserWithoutCalendly
                                ? "Link Calendly"
                                : "Re-link Calendly"}
                            </DropdownMenuItem>
                          )}
                          <RequirePermission permission="team:assign-event-type">
                            {canAssignEventType && (
                              <DropdownMenuItem
                                onClick={() => onAssignEventType(member._id)}
                              >
                                <CalendarPlusIcon data-icon="inline-start" />
                                {member.personalEventTypeUri
                                  ? "Change Event Type"
                                  : "Assign Event Type"}
                              </DropdownMenuItem>
                            )}
                          </RequirePermission>
                          <RequirePermission permission="team:update-role">
                            {canEditRole && (
                              <DropdownMenuItem
                                onClick={() => onEditRole(member._id, member.role)}
                              >
                                <ShieldIcon data-icon="inline-start" />
                                Edit Role
                              </DropdownMenuItem>
                            )}
                          </RequirePermission>
                          <RequirePermission permission="team:manage-availability">
                            {canMarkUnavailable && (
                              <DropdownMenuItem
                                onClick={() => onMarkUnavailable(member._id)}
                              >
                                <CalendarOffIcon data-icon="inline-start" />
                                Mark Unavailable
                              </DropdownMenuItem>
                            )}
                          </RequirePermission>
                        </DropdownMenuGroup>
                        <RequirePermission permission="team:remove">
                          {canRemove && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuGroup>
                                <DropdownMenuItem
                                  onClick={() => onRemoveUser(member._id)}
                                  variant="destructive"
                                >
                                  <Trash2Icon data-icon="inline-start" />
                                  Remove User
                                </DropdownMenuItem>
                              </DropdownMenuGroup>
                            </>
                          )}
                        </RequirePermission>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
