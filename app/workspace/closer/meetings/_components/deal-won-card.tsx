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
import { formatCurrency } from "@/lib/format-currency";

type EnrichedPayment = {
  _id: string;
  amount: number;
  currency: string;
  programName?: string | null;
  paymentType?: string | null;
  commissionable?: boolean;
  referenceCode?: string;
  status: "recorded" | "verified" | "disputed";
  recordedAt: number;
  proofFileUrl: string | null;
  proofFileContentType: string | null;
  proofFileSize: number | null;
  origin?: string;
  attributedCloserId?: string | null;
  attributedCloserName?: string | null;
  recordedByUserId?: string;
  recordedByName?: string | null;
};

type DealWonCardProps = {
  payments: EnrichedPayment[];
};

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

/**
 * Deal Won Card — displays payment details when opportunity is payment_received.
 *
 * Shows: amount, program, payment type, commissionability, attribution,
 * reference code, recorded timestamp, and proof file.
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

              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Amount Paid
                  </dt>
                  <dd className="text-lg font-semibold">
                    {formatCurrency(payment.amount, payment.currency)}
                  </dd>
                </div>

                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Program
                  </dt>
                  <dd className="text-sm font-medium">
                    {payment.programName ?? "Not set"}
                  </dd>
                </div>

                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Payment Type
                  </dt>
                  <dd className="text-sm font-medium">
                    {formatPaymentTypeLabel(payment.paymentType)}
                  </dd>
                </div>

                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Revenue
                  </dt>
                  <dd className="text-sm font-medium">
                    {payment.commissionable === false
                      ? "Non-commissionable"
                      : "Commissionable"}
                  </dd>
                </div>

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

                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Recorded
                  </dt>
                  <dd className="flex items-center gap-1.5 text-sm">
                    <CalendarIcon className="size-3.5 text-muted-foreground" />
                    {format(payment.recordedAt, "MMM d, yyyy 'at' h:mm a")}
                  </dd>
                </div>

                {payment.attributedCloserName && (
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Attributed To
                    </dt>
                    <dd className="flex items-center gap-1.5 text-sm font-medium">
                      <UserIcon className="size-3.5 text-muted-foreground" />
                      {payment.attributedCloserName}
                    </dd>
                  </div>
                )}

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

              {payment.origin === "admin_meeting" &&
                payment.attributedCloserId &&
                payment.recordedByUserId &&
                payment.attributedCloserId !== payment.recordedByUserId && (
                  <p className="mt-2 text-xs italic text-muted-foreground">
                    Logged on behalf by{" "}
                    <span className="font-medium">
                      {payment.recordedByName ?? "an admin"}
                    </span>
                  </p>
                )}

              {payment.proofFileUrl && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Proof of Payment
                  </p>
                  <div className="flex items-center gap-3 rounded-lg border bg-background p-3">
                    {isImage ? (
                      <>
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

function isImageContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType.startsWith("image/");
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatPaymentTypeLabel(paymentType?: string | null): string {
  switch (paymentType) {
    case "monthly":
      return "Monthly";
    case "split":
      return "Split";
    case "pif":
      return "Paid in Full";
    case "deposit":
      return "Deposit";
    default:
      return "Not set";
  }
}
