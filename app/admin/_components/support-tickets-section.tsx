"use client";

import { usePaginatedQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PAGE_SIZE = 10;

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function SupportTicketsSection() {
  const {
    results: tickets,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.admin.supportTickets.listSupportTickets,
    {},
    { initialNumItems: PAGE_SIZE },
  );

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <div className="border-b border-border px-6 py-4">
        <h2 className="text-sm font-semibold text-card-foreground">
          Support Requests
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Requests submitted from the public support page. This query is gated
          to system admins in Convex.
        </p>
      </div>

      {paginationStatus === "LoadingFirstPage" ? (
        <div
          className="flex items-center gap-3 px-6 py-8 text-sm text-muted-foreground"
          role="status"
        >
          <Spinner className="size-4" />
          Loading support requests&hellip;
        </div>
      ) : tickets.length === 0 ? (
        <div className="px-6 py-8 text-center text-sm text-muted-foreground">
          No support requests yet.
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Requester</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.map((ticket) => (
                  <TableRow key={ticket._id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      <time dateTime={new Date(ticket.createdAt).toISOString()}>
                        {dateTimeFormatter.format(ticket.createdAt)}
                      </time>
                    </TableCell>
                    <TableCell>
                      <div className="min-w-40">
                        <div className="font-medium">{ticket.name}</div>
                        <a
                          href={`mailto:${ticket.email}`}
                          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                        >
                          {ticket.email}
                        </a>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <div className="min-w-36">
                        <div>{ticket.organizationName ?? "-"}</div>
                        {ticket.slackWorkspace ? (
                          <div className="text-xs">
                            Slack: {ticket.slackWorkspace}
                          </div>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-44 flex-col gap-1">
                        <span className="font-medium">{ticket.subject}</span>
                        <Badge variant="outline" className="w-fit">
                          {ticket.status}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-md text-sm leading-6 text-muted-foreground">
                      <p className="line-clamp-4 whitespace-pre-wrap">
                        {ticket.message}
                      </p>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="border-t border-border bg-muted/30 px-6 py-3.5">
            <div className="flex items-center justify-between gap-4">
              <div className="text-xs text-muted-foreground">
                Showing {tickets.length} request
                {tickets.length !== 1 ? "s" : ""}
                {paginationStatus === "Exhausted" && " (all loaded)"}
              </div>
              {paginationStatus === "CanLoadMore" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => loadMore(PAGE_SIZE)}
                  className="whitespace-nowrap"
                >
                  Load More
                </Button>
              ) : null}
              {paginationStatus === "LoadingMore" ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-3" />
                  Loading more&hellip;
                </div>
              ) : null}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
