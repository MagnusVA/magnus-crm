import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OpportunityRow } from "./opportunity-row";

type Opportunity = {
  _id: string;
  leadName: string;
  leadEmail?: string;
  status: string;
  latestMeetingId?: string;
  latestMeetingAt?: number;
  createdAt: number;
};

type OpportunityTableProps = {
  opportunities: Opportunity[];
};

/**
 * Data table for the closer's pipeline.
 *
 * Columns: Lead · Status · Meeting · Created · Actions.
 *
 * Follows web‑design‑guidelines: `<th>` with proper `scope`, tabular‑nums
 * on date columns, keyboard‑navigable action buttons.
 */
export function OpportunityTable({ opportunities }: OpportunityTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Lead</TableHead>
          <TableHead scope="col">Status</TableHead>
          <TableHead scope="col">Meeting</TableHead>
          <TableHead scope="col">Created</TableHead>
          <TableHead scope="col" className="text-right">
            Actions
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {opportunities.map((opp) => (
          <OpportunityRow
            key={opp._id}
            leadName={opp.leadName}
            leadEmail={opp.leadEmail}
            status={opp.status}
            latestMeetingId={opp.latestMeetingId}
            latestMeetingAt={opp.latestMeetingAt}
            createdAt={opp.createdAt}
          />
        ))}
      </TableBody>
    </Table>
  );
}
