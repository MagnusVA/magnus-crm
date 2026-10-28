-- Clears contact details Fivetran copied before their columns were blocked
-- (docs/plans/clickhouse-reporting.md §7.4). Run as the admin user once,
-- after blocking these columns on the Fivetran connector; blocking stops new
-- values but keeps the ones already synced. The views never select them.
-- Booking form answers stay in convex_app.meetingformresponses because the
-- Leads reports count them; the form_answers view masks the contact ones.
--
-- Run it in one session (pnpm ch:migrate-style, or the console with every
-- statement selected): mutations_sync makes each UPDATE wait until it has
-- finished on every replica instead of running in the background. Then run
-- the check at the end; it must return no rows.
SET mutations_sync = 2;

ALTER TABLE convex_app.leads UPDATE email = NULL, phone = NULL, socialhandles = NULL, searchtext = NULL, customfields = NULL, customfieldlabels = NULL WHERE 1;
ALTER TABLE convex_app.leadgenprospects UPDATE rawhandle = NULL, normalizedhandle = NULL, profileurl = NULL, dedupekey = NULL WHERE 1;
ALTER TABLE convex_app.slackqualificationevents UPDATE handlesnapshot = NULL WHERE 1;
ALTER TABLE convex_app.users UPDATE email = NULL WHERE 1;
ALTER TABLE convex_app.leadgenworkers UPDATE email = NULL WHERE 1;
ALTER TABLE convex_app.meetings UPDATE noshownote = NULL WHERE 1;
ALTER TABLE convex_app.opportunities UPDATE notes = NULL, hostcalendlyemail = NULL WHERE 1;
ALTER TABLE convex_app.paymentrecords UPDATE note = NULL WHERE 1;
ALTER TABLE convex_app.followups UPDATE remindernote = NULL, completionnote = NULL WHERE 1;
ALTER TABLE convex_app.slackusers UPDATE username = NULL, avatarurl = NULL WHERE 1;
-- meetings.notes hasn't synced yet. Once system.columns shows it, run:
-- ALTER TABLE convex_app.meetings UPDATE notes = NULL WHERE 1;

-- Must return no rows: a row is a cleanup still running or one that failed.
SELECT table, command, is_done, latest_fail_reason
FROM system.mutations
WHERE database = 'convex_app'
  AND command LIKE 'UPDATE %'
  AND (NOT is_done OR latest_fail_reason != '');
