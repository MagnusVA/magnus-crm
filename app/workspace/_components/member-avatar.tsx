"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export type MemberAvatarIdentity = {
  id: string;
  name: string | null;
  email?: string | null;
  imageUrl?: string | null;
  imageSource?: "custom_storage" | "workos" | "slack" | "none";
  secondaryLabel?: string | null;
  isActive?: boolean | null;
  source: "crm_user" | "slack" | "dm_closer" | "system" | "unknown";
};

export type MemberAvatarSize = "sm" | "default" | "lg";

function cleanDisplayValue(value?: string | null) {
  const trimmed = value?.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed : null;
}

export function getMemberDisplayName(identity: MemberAvatarIdentity) {
  return (
    cleanDisplayValue(identity.name) ??
    cleanDisplayValue(identity.email) ??
    "Unknown"
  );
}

export function getMemberInitials(
  name?: string | null,
  email?: string | null,
) {
  const base =
    cleanDisplayValue(name) ?? cleanDisplayValue(email?.split("@")[0]) ?? "";
  if (!base) return "?";

  const parts = base.split(" ").filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }

  return base.slice(0, 2).toUpperCase();
}

export function MemberAvatar({
  identity,
  size = "sm",
  className,
  decorative = true,
}: {
  identity: MemberAvatarIdentity;
  size?: MemberAvatarSize;
  className?: string;
  decorative?: boolean;
}) {
  const label = getMemberDisplayName(identity);
  const imageUrl = cleanDisplayValue(identity.imageUrl);

  // Use decorative=false only when no adjacent text labels the member.
  return (
    <Avatar
      size={size}
      className={cn("bg-muted", className)}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : label}
      role={decorative ? undefined : "img"}
    >
      {imageUrl ? (
        <AvatarImage src={imageUrl} alt="" referrerPolicy="no-referrer" />
      ) : null}
      <AvatarFallback className="font-medium uppercase">
        {getMemberInitials(identity.name, identity.email)}
      </AvatarFallback>
    </Avatar>
  );
}
