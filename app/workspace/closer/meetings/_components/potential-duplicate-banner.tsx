"use client";

import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { UsersIcon } from "lucide-react";

type PotentialDuplicateBannerProps = {
  duplicateLead: {
    _id: string;
    fullName?: string;
    email: string;
  };
  currentLeadName?: string;
};

/**
 * Non-blocking informational banner shown on the meeting detail page
 * when the pipeline detected a potential duplicate lead during identity resolution.
 *
 * Displays the suspected duplicate's name and email. In Feature C (Lead Manager),
 * this banner will gain a "Review & Merge" action button.
 */
export function PotentialDuplicateBanner({
  duplicateLead,
  currentLeadName,
}: PotentialDuplicateBannerProps) {
  const duplicateLeadLabel = duplicateLead.fullName ?? duplicateLead.email;
  const showEmailDetail = duplicateLead.fullName !== undefined;

  return (
    <Alert
      role="status"
      variant="default"
      className="border-amber-500 bg-amber-50 dark:bg-amber-950/20"
    >
      <UsersIcon aria-hidden="true" className="text-amber-600 dark:text-amber-400" />
      <AlertTitle className="text-amber-800 dark:text-amber-200">
        Potential Duplicate Lead
      </AlertTitle>
      <AlertDescription className="break-words text-amber-700 dark:text-amber-300">
        {currentLeadName ? (
          <>
            <span className="font-medium">{currentLeadName}</span> might be the
            same person as{" "}
            <span className="font-medium">{duplicateLeadLabel}</span>
            {showEmailDetail ? ` (${duplicateLead.email})` : null}.
          </>
        ) : (
          <>
            This lead might be the same as{" "}
            <span className="font-medium">{duplicateLeadLabel}</span>
            {showEmailDetail ? ` (${duplicateLead.email})` : null}.
          </>
        )}{" "}
        Review their profiles to determine if they should be merged.
      </AlertDescription>
    </Alert>
  );
}
