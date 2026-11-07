"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useBrowserTimezone } from "@/hooks/use-browser-timezone";
import { getErrorMessage } from "@/lib/errors";

const zones = ["UTC", ...Intl.supportedValuesOf("timeZone")];

export function ProfileTimezoneRow() {
  const user = useQuery(api.users.queries.getCurrentUser);
  const update = useMutation(api.users.timezone.updateMyTimezone);
  const browserZone = useBrowserTimezone();
  const [saving, setSaving] = useState(false);
  async function save(timeZone: string) {
    setSaving(true);
    try {
      await update({ timeZone });
      toast.success("Time zone updated.");
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't update your time zone."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-x-3 px-4 py-3">
      <label
        htmlFor="profile-timezone"
        className="pt-1.5 text-[13px] text-muted-foreground"
      >
        Time zone
      </label>
      <div className="flex min-w-0 flex-col items-start gap-2">
        <Select
          value={user?.timezone ?? browserZone ?? ""}
          onValueChange={save}
          disabled={saving}
        >
          <SelectTrigger id="profile-timezone" className="w-full">
            <SelectValue placeholder="Choose a time zone" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {[
                ...new Set([
                  ...zones,
                  ...(browserZone ? [browserZone] : []),
                  ...(user?.timezone ? [user.timezone] : []),
                ]),
              ]
                .sort()
                .map((zone) => (
                  <SelectItem key={zone} value={zone}>
                    {zone.replaceAll("_", " ")}
                  </SelectItem>
                ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          variant="link"
          size="sm"
          className="px-0"
          disabled={saving || !browserZone}
          onClick={() => browserZone && void save(browserZone)}
        >
          {saving && <Spinner data-icon="inline-start" />}Set from your browser
        </Button>
        <p className="text-[13px] text-muted-foreground">
          Reports use your time zone. Today follows the workspace business day.
        </p>
      </div>
    </div>
  );
}
