"use client";

import { useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { CustomersTable } from "./customers-table";

type StatusFilter = "active" | "churned" | "paused" | undefined;

export function CustomersPageClient() {
  usePageTitle("Customers");

  const [statusFilter, setStatusFilter] = useState<StatusFilter>(undefined);

  const { results, loadMore, status } = usePaginatedQuery(
    api.customers.queries.listCustomers,
    { statusFilter },
    { initialNumItems: 25 },
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="text-sm text-muted-foreground">
            View all customers and their payment history.
          </p>
        </div>
      </div>

      {/* Status filter tabs */}
      <Card className="p-4">
        <Tabs
          value={statusFilter ?? ""}
          onValueChange={(val) =>
            setStatusFilter(
              val === "" ? undefined : (val as "active" | "churned" | "paused"),
            )
          }
        >
          <TabsList>
            <TabsTrigger value="">All</TabsTrigger>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="churned">Churned</TabsTrigger>
            <TabsTrigger value="paused">Paused</TabsTrigger>
          </TabsList>
        </Tabs>
      </Card>

      {/* Customers table */}
      <CustomersTable
        customers={results}
        isLoading={status === "LoadingFirstPage"}
        canLoadMore={status === "CanLoadMore"}
        onLoadMore={() => loadMore(25)}
      />
    </div>
  );
}
