"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  TrophyIcon,
  CreditCardIcon,
  UserIcon,
  CalendarIcon,
  FileIcon,
  ImageIcon,
  DownloadIcon,
  ZoomInIcon,
  ExternalLinkIcon,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────

type EnrichedPayment = {
  _id: string;
  amount: number;
  currency: string;
  provider: string;
  referenceCode?: string;
  status: "recorded" | "verified" | "disputed";
  recordedAt: number;
  proofFileUrl: string | null;
  proofFileContentType: string | null;
  proofFileSize: number | null;
  closerName: string | null;
};

type DealWonCardProps = {
  payments: EnrichedPayment[];
};

// ─── Config ─────────────────────────────────────────────────────────────────

const PAYMENT_STATUS_CONFIG = {
  recorded: {
    label: "Recorded",
    badgeClass:
      "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
  },
  verified: {
    label: "Verified",
    badgeClass:
      "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-900",
  },
  disputed: {
    label: "Disputed",
    badgeClass:
      "bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-900",
  },
} as const;

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Deal Won Card — displays payment details when opportunity is payment_received.
 *
 * Shows: amount, provider, reference code, recorded timestamp, recorded by,
 * payment status badge, and proof file (image thumbnail with lightbox, or
 * PDF/file download link).
 *
 * Returns null when no payments exist (guard in parent component ensures
 * this card only renders for won opportunities with payments).
 */
export function DealWonCard({ payments }: DealWonCardProps) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  if (payments.length === 0) return null;

  return (
    <Card className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/30">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <TrophyIcon className="size-5 text-emerald-600 dark:text-emerald-400" />
          <CardTitle className="text-base">Deal Won</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {payments.map((payment, idx) => {
          const statusCfg = PAYMENT_STATUS_CONFIG[payment.status];
          const isImage = isImageContentType(payment.proofFileContentType);

          return (
            <div key={payment._id}>
              {idx > 0 && <Separator className="mb-4" />}

              {/* Payment details grid */}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                {/* Amount */}
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Amount Paid
                  </dt>
                  <dd className="text-lg font-semibold">
                    {formatCurrency(payment.amount, payment.currency)}
                  </dd>
                </div>

                {/* Provider */}
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Provider
                  </dt>
                  <dd className="flex items-center gap-1.5 text-sm font-medium">
                    <CreditCardIcon className="size-3.5 text-muted-foreground" />
                    {payment.provider}
                  </dd>
                </div>

                {/* Reference Code */}
                {payment.referenceCode && (
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Reference
                    </dt>
                    <dd className="truncate font-mono text-sm">
                      {payment.referenceCode}
                    </dd>
                  </div>
                )}

                {/* Recorded At */}
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Recorded
                  </dt>
                  <dd className="flex items-center gap-1.5 text-sm">
                    <CalendarIcon className="size-3.5 text-muted-foreground" />
                    {format(payment.recordedAt, "MMM d, yyyy 'at' h:mm a")}
                  </dd>
                </div>

                {/* Recorded By */}
                {payment.closerName && (
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Recorded By
                    </dt>
                    <dd className="flex items-center gap-1.5 text-sm font-medium">
                      <UserIcon className="size-3.5 text-muted-foreground" />
                      {payment.closerName}
                    </dd>
                  </div>
                )}

                {/* Status */}
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Status
                  </dt>
                  <dd>
                    <Badge
                      variant="secondary"
                      className={cn("text-xs", statusCfg.badgeClass)}
                    >
                      {statusCfg.label}
                    </Badge>
                  </dd>
                </div>
              </dl>

              {/* Proof File Display (I2) */}
              {payment.proofFileUrl && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Proof of Payment
                  </p>
                  <div className="flex items-center gap-3 rounded-lg border bg-background p-3">
                    {isImage ? (
                      <>
                        {/* Image thumbnail with lightbox trigger */}
                        <button
                          type="button"
                          onClick={() => setLightboxUrl(payment.proofFileUrl)}
                          className="group relative shrink-0 overflow-hidden rounded-md border"
                          aria-label="View proof image full size"
                        >
                          <img
                            src={payment.proofFileUrl}
                            alt="Payment proof"
                            className="size-16 object-cover transition-opacity group-hover:opacity-80"
                          />
                          <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/20">
                            <ZoomInIcon className="size-4 text-white opacity-0 transition-opacity group-hover:opacity-100" />
                          </div>
                        </button>
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 text-sm font-medium">
                            <ImageIcon className="size-3.5 text-blue-600 dark:text-blue-400" />
                            Image proof
                          </p>
                          {payment.proofFileSize != null && (
                            <p className="text-xs text-muted-foreground">
                              {formatFileSize(payment.proofFileSize)}
                            </p>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
                        {/* Non-image file (PDF, etc.) */}
                        <div className="flex size-16 shrink-0 items-center justify-center rounded-md border bg-muted">
                          <FileIcon className="size-6 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 text-sm font-medium">
                            <FileIcon className="size-3.5 text-muted-foreground" />
                            {payment.proofFileContentType === "application/pdf"
                              ? "PDF proof"
                              : "File proof"}
                          </p>
                          {payment.proofFileSize != null && (
                            <p className="text-xs text-muted-foreground">
                              {formatFileSize(payment.proofFileSize)}
                            </p>
                          )}
                        </div>
                      </>
                    )}

                    {/* Download / Open button */}
                    <Button variant="outline" size="sm" asChild>
                      <a
                        href={payment.proofFileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {isImage ? (
                          <ExternalLinkIcon data-icon="inline-start" />
                        ) : (
                          <DownloadIcon data-icon="inline-start" />
                        )}
                        {isImage ? "Open" : "Download"}
                      </a>
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Image Lightbox Dialog */}
        <Dialog
          open={lightboxUrl !== null}
          onOpenChange={(open) => {
            if (!open) setLightboxUrl(null);
          }}
        >
          <DialogContent className="max-w-3xl p-2">
            <DialogTitle className="sr-only">Payment proof image</DialogTitle>
            {lightboxUrl && (
              <img
                src={lightboxUrl}
                alt="Payment proof — full size"
                className="w-full rounded-lg"
              />
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isImageContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.startsWith("image/");
}

function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    // Fallback for unsupported currency codes
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
