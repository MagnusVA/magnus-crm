-- paymentRecords
-- Keep the recorder nullable. Provider origin guarantees the provider entry
-- channel even before Fivetran syncs recordedvia. Other entry channels stay NULL.
-- Not synced yet, NULL until Fivetran adds the column: referencecode, fathomlink, verifiedat, verifiedbyuserid
CREATE OR REPLACE VIEW analytics.payments
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    origin AS origin,
    meetingid AS meeting_id,
    attributedcloserid AS attributed_closer_id,
    amountminor AS amount_minor,
    paymenttype AS payment_type,
    opportunityid AS opportunity_id,
    CAST(statuschangedat AS Nullable(Int64)) AS status_changed_at_ms,
    programname AS program_name,
    CAST(recordedat AS Nullable(Int64)) AS recorded_at_ms,
    assumeNotNull(tenantid) AS tenant_id,
    currency AS currency,
    nullIf(recordedbyuserid, '') AS recorded_by_user_id,
    programid AS program_id,
    status AS status,
    prooffileid AS proof_file_id,
    CAST(NULL AS Nullable(String)) AS reference_code,
    CAST(NULL AS Nullable(String)) AS fathom_link,
    CAST(NULL AS Nullable(Int64)) AS verified_at_ms,
    CAST(NULL AS Nullable(String)) AS verified_by_user_id,
    if(origin = 'provider', 'provider', CAST(NULL AS Nullable(String))) AS recorded_via
FROM convex_app.paymentrecords FINAL
WHERE NOT _fivetran_deleted;
