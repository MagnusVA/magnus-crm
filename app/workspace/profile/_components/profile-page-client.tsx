"use client";

import type { ComponentType, ReactNode } from "react";
import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MemberAvatar } from "@/app/workspace/_components/member-avatar";
import {
  Alert,
  AlertDescription,
} from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  CalendarIcon,
  Loader2Icon,
  MailIcon,
  ShieldIcon,
  Trash2Icon,
  UploadIcon,
  UserIcon,
} from "lucide-react";
import ProfileLoading from "../loading";

const allowedProfilePictureTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const allowedProfilePictureAccept = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
].join(",");
const maxProfilePictureBytes = 2 * 1024 * 1024;

type CurrentUser = NonNullable<
  FunctionReturnType<typeof api.users.queries.getCurrentUser>
>;

export function ProfilePageClient() {
  usePageTitle("Profile");
  const user = useQuery(api.users.queries.getCurrentUser);

  if (user === undefined) {
    return <ProfileLoading />;
  }

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
          <div className="flex flex-col gap-5">
            <ProfilePictureControl user={user} />
            <Separator />
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

function ProfilePictureControl({ user }: { user: CurrentUser }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [profilePictureError, setProfilePictureError] = useState<string | null>(
    null,
  );
  const generateUploadUrl = useMutation(
    api.users.profilePictures.generateProfilePictureUploadUrl,
  );
  const saveProfilePicture = useMutation(
    api.users.profilePictures.saveProfilePicture,
  );
  const removeProfilePicture = useMutation(
    api.users.profilePictures.removeProfilePicture,
  );

  const hasCustomProfilePicture = user.avatar.imageSource === "custom_storage";
  const isBusy = isUploading || isRemoving;

  function resetFileInput() {
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  function rejectFile(message: string) {
    setProfilePictureError(message);
    toast.error(message);
    resetFileInput();
  }

  async function uploadProfilePicture(file: File) {
    if (!allowedProfilePictureTypes.has(file.type)) {
      rejectFile("Profile picture must be a JPEG, PNG, WebP, or GIF image.");
      return;
    }

    if (file.size > maxProfilePictureBytes) {
      rejectFile("Profile picture must be 2 MB or smaller.");
      return;
    }

    setIsUploading(true);
    setProfilePictureError(null);

    try {
      const uploadUrl = await generateUploadUrl();
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!response.ok) {
        throw new Error("Failed to upload profile picture.");
      }

      const { storageId } = (await response.json()) as {
        storageId?: Id<"_storage">;
      };
      if (!storageId) {
        throw new Error("Upload did not return a storage ID.");
      }

      await saveProfilePicture({ storageId });
      toast.success("Profile picture updated.");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Profile picture upload failed.";
      setProfilePictureError(message);
      toast.error(message);
    } finally {
      setIsUploading(false);
      resetFileInput();
    }
  }

  async function removeCurrentProfilePicture() {
    setIsRemoving(true);
    setProfilePictureError(null);

    try {
      await removeProfilePicture();
      toast.success("Profile picture removed.");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Profile picture removal failed.";
      setProfilePictureError(message);
      toast.error(message);
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <MemberAvatar identity={user.avatar} size="lg" decorative={false} />
        <input
          ref={inputRef}
          type="file"
          accept={allowedProfilePictureAccept}
          className="sr-only"
          aria-label="Profile picture file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void uploadProfilePicture(file);
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isBusy}
          onClick={() => inputRef.current?.click()}
        >
          {isUploading ? (
            <Loader2Icon
              data-icon="inline-start"
              className="animate-spin"
              aria-hidden="true"
            />
          ) : (
            <UploadIcon data-icon="inline-start" aria-hidden="true" />
          )}
          {isUploading
            ? "Uploading"
            : hasCustomProfilePicture
              ? "Replace"
              : "Upload"}
        </Button>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove profile picture"
                disabled={isBusy || !hasCustomProfilePicture}
                onClick={() => {
                  void removeCurrentProfilePicture();
                }}
              >
                <Trash2Icon data-icon="inline-start" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Remove profile picture</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {profilePictureError ? (
        <Alert variant="destructive">
          <AlertDescription>{profilePictureError}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType;
  label: string;
  value: ReactNode;
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
