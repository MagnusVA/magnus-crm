"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { UsersIcon, UserCheckIcon, TrendingUpIcon } from "lucide-react";

interface ConversionKpiCardsProps {
  newLeads: number;
  totalConversions: number;
  conversionRate: number | null;
}

export function ConversionKpiCards({
  newLeads,
  totalConversions,
  conversionRate,
}: ConversionKpiCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">New Leads</CardTitle>
          <UsersIcon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{newLeads.toLocaleString()}</div>
          <p className="text-xs text-muted-foreground">
            Leads created in period
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Conversions</CardTitle>
          <UserCheckIcon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {totalConversions.toLocaleString()}
          </div>
          <p className="text-xs text-muted-foreground">
            Leads converted to customers
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Conversion Rate</CardTitle>
          <TrendingUpIcon className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">
            {conversionRate !== null
              ? `${(conversionRate * 100).toFixed(1)}%`
              : "\u2014"}
          </div>
          <p className="text-xs text-muted-foreground">
            {totalConversions} of {newLeads} leads
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
