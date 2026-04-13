"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ConversionByCloserTableProps {
  byCloser: Array<{
    closerId: string;
    closerName: string;
    conversions: number;
  }>;
  totalConversions: number;
}

export function ConversionByCloserTable({
  byCloser,
  totalConversions,
}: ConversionByCloserTableProps) {
  const sorted = [...byCloser].sort((a, b) => b.conversions - a.conversions);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversions by Closer</CardTitle>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No conversions recorded in this period
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Closer</TableHead>
                <TableHead className="text-right">Conversions</TableHead>
                <TableHead className="text-right">% of Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((row) => (
                <TableRow key={row.closerId}>
                  <TableCell>{row.closerName}</TableCell>
                  <TableCell className="text-right">
                    {row.conversions}
                  </TableCell>
                  <TableCell className="text-right">
                    {totalConversions > 0
                      ? `${((row.conversions / totalConversions) * 100).toFixed(1)}%`
                      : "0.0%"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-bold">Total</TableCell>
                <TableCell className="text-right font-bold">
                  {totalConversions}
                </TableCell>
                <TableCell className="text-right font-bold">
                  {totalConversions > 0 ? "100.0%" : "0.0%"}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
