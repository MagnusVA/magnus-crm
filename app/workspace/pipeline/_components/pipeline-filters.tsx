"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";

const statuses = [
  { value: "all", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "in_progress", label: "In Progress" },
  { value: "follow_up_scheduled", label: "Follow-up" },
  { value: "payment_received", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "canceled", label: "Canceled" },
  { value: "no_show", label: "No Show" },
];

interface PipelineFiltersProps {
  statusFilter: string;
  closerFilter: string;
  closers: Array<{ _id: string; fullName?: string; email: string }>;
  onStatusChange: (status: string) => void;
  onCloserChange: (closerId: string) => void;
}

export function PipelineFilters({
  statusFilter,
  closerFilter,
  closers,
  onStatusChange,
  onCloserChange,
}: PipelineFiltersProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex-1">
            <p className="mb-3 text-sm font-medium">Status</p>
            <Tabs value={statusFilter} onValueChange={onStatusChange}>
              <TabsList className="grid w-full grid-cols-4 lg:grid-cols-8">
                {statuses.map((status) => (
                  <TabsTrigger key={status.value} value={status.value} className="text-xs">
                    {status.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          <div className="w-full md:w-48">
            <p className="mb-3 text-sm font-medium">Closer</p>
            <Select value={closerFilter} onValueChange={onCloserChange}>
              <SelectTrigger>
                <SelectValue placeholder="All closers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All closers</SelectItem>
                {closers.map((closer) => (
                  <SelectItem key={closer._id} value={closer._id}>
                    {closer.fullName || closer.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
