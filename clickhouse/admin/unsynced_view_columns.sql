-- Columns the views fill with NULL because Fivetran hadn't synced them yet
-- (clickhouse/migrations/0002_views.sql). Run as the admin user now and then,
-- and after a feature first sets one of these fields. Every row this returns
-- is a column that now exists in convex_app: replace its NULL in a new
-- migration, the same CREATE OR REPLACE VIEW with the column selected.
SELECT database, table, name, type
FROM system.columns
WHERE database = 'convex_app'
  AND (table, name) IN (
    ('meetings', 'reassignedfromcloserid'),
    ('paymentrecords', 'referencecode'),
    ('paymentrecords', 'fathomlink'),
    ('paymentrecords', 'verifiedat'),
    ('paymentrecords', 'verifiedbyuserid'),
    ('leadgensubmissions', 'voidedat'),
    ('leadgensubmissions', 'voidedbyuserid'),
    ('leadgensubmissions', 'voidreason'),
    ('enrollments', 'statuschangedat'),
    ('enrollments', 'statuschangedbyuserid'),
    ('leads', 'initialsource'),
    ('leads', 'lifecyclestagemovedbackat'),
    ('users', 'personaleventtypeuri'),
    ('tenantprograms', 'description'),
    ('tenantprograms', 'archivedat'),
    ('dmclosers', 'hourlyrateminor'),
    ('slackusers', 'crmuserid'),
    ('slackusers', 'dailyqualificationquota'),
    ('eventtypeconfigs', 'paymentlinks'),
    ('eventtypeconfigs', 'calendlydeletedat')
  )
ORDER BY table, name;
