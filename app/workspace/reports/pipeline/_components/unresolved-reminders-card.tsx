"use client";

import { BellRingIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface UnresolvedRemindersCardProps {
  count: number;
  split: {
    admin: number;
    closer: number;
    system: number;
  };
  isTruncated: boolean;
}

export function UnresolvedRemindersCard({
  count,
  split,
  isTruncated,
}: UnresolvedRemindersCardProps) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-muted-foreground">
          <BellRingIcon className="size-4" />
          Unresolved Reminders
        </CardTitle>
        <CardDescription>Manual reminders still open right now.</CardDescription>
        <CardAction className="flex items-center gap-2">
          <Badge variant="outline">Current</Badge>
          {isTruncated ? <Badge variant="secondary">2000+</Badge> : null}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="text-2xl font-bold tabular-nums">
          {count.toLocaleString()}
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">
            Closer {split.closer.toLocaleString()}
          </Badge>
          <Badge variant="outline">
            Admin {split.admin.toLocaleString()}
          </Badge>
          {split.system > 0 ? (
            <Badge variant="outline">
              System {split.system.toLocaleString()}
            </Badge>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
