"use client";

import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";
import { ChevronRightIcon } from "lucide-react";
import { formatCurrency } from "@/lib/format-currency";
import type { Id } from "@/convex/_generated/dataModel";
import { CustomerStatusBadge } from "./customer-status-badge";

interface Customer {
  _id: Id<"customers">;
  fullName: string;
  email: string;
  convertedAt: number;
  totalPaid: number;
  currency: string;
  status: "active" | "churned" | "paused";
  convertedByName: string;
}

interface CustomersTableProps {
  customers: (Customer | null)[];
  isLoading: boolean;
  canLoadMore: boolean;
  onLoadMore: () => void;
}

export function CustomersTable({
  customers,
  isLoading,
  canLoadMore,
  onLoadMore,
}: CustomersTableProps) {
  const filteredCustomers = customers.filter(Boolean) as Customer[];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-muted-foreground">Loading customers...</p>
      </div>
    );
  }

  if (filteredCustomers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12">
        <p className="text-muted-foreground">No customers yet.</p>
        <p className="text-sm text-muted-foreground">
          Customers are created when a payment is recorded on an opportunity.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Converted</TableHead>
              <TableHead className="text-right">Total Paid</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Converted By</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredCustomers.map((customer) => (
              <TableRow
                key={customer._id}
                className="cursor-pointer hover:bg-muted/50"
              >
                <TableCell className="font-medium">
                  <Link
                    href={`/workspace/customers/${customer._id}`}
                    className="hover:underline"
                  >
                    {customer.fullName}
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {customer.email}
                </TableCell>
                <TableCell className="text-sm">
                  {formatDistanceToNow(new Date(customer.convertedAt), {
                    addSuffix: true,
                  })}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {formatCurrency(customer.totalPaid, customer.currency)}
                </TableCell>
                <TableCell>
                  <CustomerStatusBadge status={customer.status} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {customer.convertedByName}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/workspace/customers/${customer._id}`}>
                      <ChevronRightIcon className="h-4 w-4" />
                      <span className="sr-only">View customer</span>
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {canLoadMore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
