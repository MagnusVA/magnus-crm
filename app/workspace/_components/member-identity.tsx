"use client";

import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  getMemberDisplayName,
  MemberAvatar,
  type MemberAvatarIdentity,
  type MemberAvatarSize,
} from "./member-avatar";

function cleanLabel(value?: string | null) {
  const trimmed = value?.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed : null;
}

function getSecondaryLabel(identity: MemberAvatarIdentity, name: string) {
  const secondaryLabel = cleanLabel(identity.secondaryLabel);
  if (secondaryLabel) return secondaryLabel;

  const email = cleanLabel(identity.email);
  return email && email.toLowerCase() !== name.toLowerCase() ? email : null;
}

// Use this row when it owns the visible name; use MemberAvatar for avatar-only slots.
export function MemberIdentity({
  identity,
  badge,
  size = "sm",
  className,
  textClassName,
}: {
  identity: MemberAvatarIdentity;
  badge?: ReactNode;
  size?: MemberAvatarSize;
  className?: string;
  textClassName?: string;
}) {
  const name = getMemberDisplayName(identity);
  const secondaryLabel = getSecondaryLabel(identity, name);

  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <MemberAvatar identity={identity} size={size} />
      <div className={cn("flex min-w-0 flex-1 flex-col", textClassName)}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-medium">{name}</span>
          {badge ? <span className="shrink-0">{badge}</span> : null}
        </div>
        {secondaryLabel ? (
          <p className="truncate text-xs text-muted-foreground">
            {secondaryLabel}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function MemberIdentityOption({
  identity,
  className,
}: {
  identity: MemberAvatarIdentity;
  className?: string;
}) {
  return (
    <MemberIdentity identity={identity} className={cn("w-full", className)} />
  );
}

export function MemberIdentitySkeleton({
  size = "sm",
  className,
}: {
  size?: MemberAvatarSize;
  className?: string;
}) {
  const avatarSizeClass =
    size === "lg" ? "size-10" : size === "default" ? "size-8" : "size-6";

  return (
    <div
      role="status"
      aria-label="Loading member"
      className={cn("flex min-w-0 items-center gap-2.5", className)}
    >
      <Skeleton className={cn("shrink-0 rounded-full", avatarSizeClass)} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-44 max-w-full" />
      </div>
    </div>
  );
}
