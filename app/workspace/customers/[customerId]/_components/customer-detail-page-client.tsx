"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeftIcon, BanknoteIcon } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { formatCurrency } from "@/lib/format-currency";
import { format, formatDistanceToNow } from "date-fns";
import { useRole } from "@/components/auth/role-context";
import { CustomerStatusBadge } from "../../_components/customer-status-badge";
import { CustomerStatusControl } from "../../_components/customer-status-control";
import { PaymentHistoryTable } from "./payment-history-table";
import { RecordPaymentDialog } from "./record-payment-dialog";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CustomerDetailPageClientProps {
  customerId: string;
}

export function CustomerDetailPageClient({
  customerId,
}: CustomerDetailPageClientProps) {
  const id = customerId as Id<"customers">;
  const { isAdmin } = useRole();
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);

  const detail = useQuery(api.customers.queries.getCustomerDetail, {
    customerId: id,
  });

  usePageTitle(
    detail?.customer?.fullName ?? "Customer Detail",
  );

  // Loading state
  if (detail === undefined) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  // Not found
  if (detail === null) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <p className="text-muted-foreground">Customer not found.</p>
        <Button variant="outline" asChild>
          <Link href="/workspace/customers">Back to Customers</Link>
        </Button>
      </div>
    );
  }

  const {
    customer,
    lead,
    winningOpportunity,
    winningMeeting,
    convertedByName,
    closerName,
    totalPaid,
    currency,
    payments,
  } = detail;

  return (
    <div className="flex flex-col gap-6">
      {/* Back button + status */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/workspace/customers">
            <ArrowLeftIcon className="mr-1.5 h-4 w-4" />
            Customers
          </Link>
        </Button>
        <CustomerStatusBadge status={customer.status} />
      </div>

      {/* Customer header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {customer.fullName}
        </h1>
        <div className="flex flex-col gap-0.5 text-sm text-muted-foreground">
          <span>{customer.email}</span>
          {customer.phone && <span>{customer.phone}</span>}
        </div>
        {/* Social handles */}
        {customer.socialHandles && customer.socialHandles.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {customer.socialHandles.map(
              (s: { type: string; handle: string }, i: number) => (
                <Badge key={i} variant="secondary" className="text-xs">
                  {s.type}: @{s.handle}
                </Badge>
              ),
            )}
          </div>
        )}
      </div>

      {/* Relationships */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Relationships</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Linked Lead */}
          {lead && (
            <Link
              href={`/workspace/leads/${customer.leadId}`}
              className="block rounded-lg border p-3 transition-colors hover:bg-accent"
            >
              <p className="text-xs text-muted-foreground">Converted Lead</p>
              <p className="font-medium">{lead.fullName ?? lead.email}</p>
            </Link>
          )}

          {/* Winning Opportunity */}
          {winningOpportunity && (
            <Link
              href={`/workspace/pipeline?opp=${customer.winningOpportunityId}`}
              className="block rounded-lg border p-3 transition-colors hover:bg-accent"
            >
              <p className="text-xs text-muted-foreground">Winning Opportunity</p>
              <p className="font-medium capitalize">
                {winningOpportunity.status.replace(/_/g, " ")}
              </p>
            </Link>
          )}

          {/* Winning Meeting */}
          {winningMeeting && (
            <Link
              href={`/workspace/closer/meetings/${winningMeeting._id}`}
              className="block rounded-lg border p-3 transition-colors hover:bg-accent"
            >
              <p className="text-xs text-muted-foreground">Winning Meeting</p>
              <p className="font-medium">
                {format(
                  new Date(winningMeeting.scheduledAt),
                  "MMM d, yyyy 'at' h:mm a",
                )}
              </p>
            </Link>
          )}
        </CardContent>
      </Card>

      {/* Conversion Details */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Conversion</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Converted At</p>
              <p className="text-sm font-medium">
                {format(new Date(customer.convertedAt), "MMM d, yyyy")}
                <span className="ml-1 text-muted-foreground">
                  (
                  {formatDistanceToNow(new Date(customer.convertedAt), {
                    addSuffix: true,
                  })}
                  )
                </span>
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Converted By</p>
              <p className="text-sm font-medium">{convertedByName}</p>
            </div>
            {closerName && (
              <div>
                <p className="text-xs text-muted-foreground">Assigned Closer</p>
                <p className="text-sm font-medium">{closerName}</p>
              </div>
            )}
            {customer.programName && (
              <div>
                <p className="text-xs text-muted-foreground">Program</p>
                <p className="text-sm font-medium">{customer.programName}</p>
              </div>
            )}
          </div>
          {customer.notes && (
            <div className="mt-4 border-t pt-4">
              <p className="text-xs text-muted-foreground">Notes</p>
              <p className="mt-1 text-sm">{customer.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payment History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Payment History</CardTitle>
            {isAdmin && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRecordPaymentOpen(true)}
                >
                  <BanknoteIcon data-icon="inline-start" />
                  Record Payment
                </Button>
                <RecordPaymentDialog
                  open={recordPaymentOpen}
                  onOpenChange={setRecordPaymentOpen}
                  customer={{
                    _id: id,
                    programId: customer.programId,
                    programName: customer.programName,
                    currency,
                  }}
                  onPaymentRecorded={() => {
                    /* useQuery auto-refreshes */
                  }}
                />
              </>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-4">
            <p className="text-3xl font-bold">
              {formatCurrency(totalPaid, currency)}
            </p>
            <p className="text-sm text-muted-foreground">
              {payments.length} payment{payments.length !== 1 ? "s" : ""}
            </p>
          </div>
          <PaymentHistoryTable payments={payments} />
        </CardContent>
      </Card>

      {/* Status Control (admin only — component self-hides for non-admins) */}
      <Card>
        <CardContent className="pt-6">
          <CustomerStatusControl
            customerId={id}
            currentStatus={customer.status}
          />
        </CardContent>
      </Card>
    </div>
  );
}
