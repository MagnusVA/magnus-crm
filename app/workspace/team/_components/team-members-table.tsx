"use client";

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
import {
  EllipsisVerticalIcon,
  AlertCircleIcon,
  Link2Icon,
  ShieldIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";

interface TeamMember {
  _id: Id<"users">;
  _creationTime: number;
  email: string;
  fullName?: string;
  role: "closer" | "tenant_admin" | "tenant_master";
  calendlyMemberName?: string;
  calendlyUserUri?: string;
}

interface TeamMembersTableProps {
  members: TeamMember[];
  onEditRole?: (memberId: Id<"users">, currentRole: string) => void;
  onRemoveUser?: (memberId: Id<"users">) => void;
  onRelinkCalendly?: (memberId: Id<"users">) => void;
}

const roleLabels: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
  closer: { label: "Closer", variant: "default" },
  tenant_admin: { label: "Admin", variant: "secondary" },
  tenant_master: { label: "Owner", variant: "outline" },
};

export function TeamMembersTable({
  members,
  onEditRole,
  onRemoveUser,
  onRelinkCalendly,
}: TeamMembersTableProps) {
  if (members.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersIcon />
          </EmptyMedia>
          <EmptyTitle>No team members yet</EmptyTitle>
          <EmptyDescription>
            Invite your first team member to get started
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
            <TableHead className="font-semibold">Name</TableHead>
            <TableHead className="font-semibold">Email</TableHead>
            <TableHead className="font-semibold">Role</TableHead>
            <TableHead className="font-semibold">Calendly Status</TableHead>
            <TableHead className="text-right font-semibold">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => {
            const role = roleLabels[member.role] ?? {
              label: member.role,
              variant: "secondary" as const,
            };
            const isCloserWithoutCalendly =
              member.role === "closer" && !member.calendlyUserUri;

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
                <TableCell className="text-right">
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
                        {member.role === "closer" && onRelinkCalendly && (
                          <DropdownMenuItem
                            onClick={() => onRelinkCalendly(member._id)}
                          >
                            <Link2Icon data-icon="inline-start" />
                            {isCloserWithoutCalendly
                              ? "Link Calendly"
                              : "Re-link Calendly"}
                          </DropdownMenuItem>
                        )}
                        {onEditRole && (
                          <DropdownMenuItem
                            onClick={() => onEditRole(member._id, member.role)}
                          >
                            <ShieldIcon data-icon="inline-start" />
                            Edit Role
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuGroup>
                      {onRemoveUser && (
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
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
