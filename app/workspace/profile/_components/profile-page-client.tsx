"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { AlertCircleIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MemberAvatar } from "@/app/workspace/_components/member-avatar";
import { PageBand } from "@/app/workspace/_components/page-band";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { usePageTitle } from "@/hooks/use-page-title";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { cn } from "@/lib/utils";
import ProfileLoading from "../loading";

const allowedProfilePictureTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const allowedProfilePictureAccept = [...allowedProfilePictureTypes].join(",");
const maxProfilePictureBytes = 2 * 1024 * 1024;

type CurrentUser = NonNullable<
  FunctionReturnType<typeof api.users.queries.getCurrentUser>
>;

const ROLE_LABELS: Record<CurrentUser["role"], string> = {
  tenant_master: "Owner",
  tenant_admin: "Admin",
  closer: "Closer",
  lead_generator: "Lead generator",
};

const STATUS_WORD =
  "font-condensed text-[15px] leading-none font-bold tracking-[0.08em] uppercase";

/**
 * The signed-in user's own record, in the person card's dense style: the
 * picture they can change, then who they are and how they're connected.
 */
export function ProfilePageClient() {
  usePageTitle("Your profile");
  const user = useQuery(api.users.queries.getCurrentUser);

  if (user === undefined) {
    return <ProfileLoading />;
  }

  if (!user) {
    return null;
  }

  return (
    <div className="@container mx-auto flex w-full max-w-[640px] flex-col gap-3.5 pb-6 short:gap-3">
      <PageBand
        title="Your profile"
        description="Managed through your organization's sign-in."
      />

      <Card className="w-full gap-0 py-0">
        <div className="divide-y [&>dl]:py-1">
          <ProfilePictureControl user={user} />
          <dl>
            <Fact label="Name">
              {user.fullName ? (
                <span translate="no">{user.fullName}</span>
              ) : (
                <Muted>Not set</Muted>
              )}
            </Fact>
            <Fact label="Email" title={user.email}>
              <span translate="no">{user.email}</span>
            </Fact>
          </dl>
          <dl>
            <Fact label="Role">{ROLE_LABELS[user.role]}</Fact>
            <Fact label="Calendly">
              {user.calendlyUserUri ? (
                <span className={cn(STATUS_WORD, "text-foreground")}>Linked</span>
              ) : (
                <>
                  <span className={cn(STATUS_WORD, "text-muted-foreground")}>Not linked</span>{" "}
                  <Muted>An admin links it from Team.</Muted>
                </>
              )}
            </Fact>
          </dl>
        </div>
      </Card>
    </div>
  );
}

/** One fact: a 96px slate label beside a one-line value, about 32px tall. */
function Fact({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-3 px-4 py-1.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate" title={title}>
        {children}
      </dd>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-[13px] text-muted-foreground">{children}</span>;
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
    let httpStatus: number | undefined;

    try {
      const uploadUrl = await generateUploadUrl();
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      httpStatus = response.status;

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
      reportClientError(error, { flow: "profile_picture_upload", httpStatus });
      const message = getErrorMessage(error, "Profile picture upload failed.");
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
      const message = getErrorMessage(error, "Profile picture removal failed.");
      setProfilePictureError(message);
      toast.error(message);
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 px-4 py-3">
      <span className="text-[13px] text-muted-foreground">Picture</span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <MemberAvatar
            identity={user.avatar}
            size="lg"
            decorative={false}
            className="mr-1"
          />
          <input
            ref={inputRef}
            type="file"
            accept={allowedProfilePictureAccept}
            className="sr-only"
            tabIndex={-1}
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
              <Spinner data-icon="inline-start" />
            ) : (
              <UploadIcon data-icon="inline-start" aria-hidden="true" />
            )}
            {isUploading
              ? "Uploading…"
              : hasCustomProfilePicture
                ? "Replace"
                : "Upload"}
          </Button>
          {hasCustomProfilePicture ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isBusy}
              onClick={() => {
                void removeCurrentProfilePicture();
              }}
            >
              {isRemoving ? <Spinner data-icon="inline-start" /> : null}
              {isRemoving ? "Removing…" : "Remove"}
            </Button>
          ) : null}
        </div>
        <p className="text-[13px] text-muted-foreground">
          JPEG, PNG, WebP or GIF, up to 2 MB.
        </p>
        {profilePictureError ? (
          <p role="alert" className="flex items-start gap-1.5 text-[13px] text-danger-ink">
            <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {profilePictureError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
