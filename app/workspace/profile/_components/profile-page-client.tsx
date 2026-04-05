"use client";

import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  UserIcon,
  MailIcon,
  ShieldIcon,
  CalendarIcon,
} from "lucide-react";

interface ProfilePageClientProps {
  preloadedProfile: Preloaded<typeof api.users.queries.getCurrentUser>;
}

export function ProfilePageClient({
  preloadedProfile,
}: ProfilePageClientProps) {
  usePageTitle("Profile");
  const user = usePreloadedQuery(preloadedProfile);

  if (!user) {
    return null;
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">My Profile</h1>
        <p className="text-sm text-muted-foreground">
          Your account information and settings
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>
            Your profile is managed through your organization&apos;s identity
            provider.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <InfoRow
              icon={UserIcon}
              label="Name"
              value={user.fullName ?? "Not set"}
            />
            <Separator />
            <InfoRow icon={MailIcon} label="Email" value={user.email} />
            <Separator />
            <InfoRow
              icon={ShieldIcon}
              label="Role"
              value={
                <Badge variant="secondary" className="capitalize">
                  {user.role.replace(/_/g, " ")}
                </Badge>
              }
            />
            <Separator />
            <InfoRow
              icon={CalendarIcon}
              label="Calendly"
              value={
                user.calendlyUserUri ? (
                  <Badge variant="default">Linked</Badge>
                ) : (
                  <Badge variant="outline">Not linked</Badge>
                )
              }
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3 text-sm">
        <Icon />
        <span className="text-muted-foreground">{label}</span>
      </div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}
