-- One view per Convex table the reports read (docs/plans/clickhouse-reporting.md §7.1).
-- Each reads FINAL (Fivetran rows stay duplicated until a merge), drops deleted
-- rows, renames columns to snake_case, turns epoch-ms timestamps into Int64
-- `*_ms` columns, keeps objects as `*_json` strings, and leaves out contact
-- fields (email, phone, handles, search text, custom fields, notes) and fields
-- the Convex schema no longer has. SQL SECURITY DEFINER lets `magnus_app` read
-- the views without any grant on convex_app.
--
-- Fivetran adds a column only once a synced row sets it, so a schema field no
-- row has set yet is a typed NULL here (listed above each view). When one
-- appears in convex_app, replace the NULL with the column in a new migration.

-- meetings
-- Not synced yet, NULL until Fivetran adds the column: reassignedfromcloserid
CREATE OR REPLACE VIEW analytics.meetings
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    bookingprogramname AS booking_program_name,
    meetingjoinurl AS meeting_join_url,
    assignedcloserid AS assigned_closer_id,
    leadname AS lead_name,
    utmtruncated AS utm_truncated,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    opportunityid AS opportunity_id,
    callclassification AS call_classification,
    calendlyeventuri AS calendly_event_uri,
    attributionresolutionversion AS attribution_resolution_version,
    calendlyinviteeuri AS calendly_invitee_uri,
    meetinglocationtype AS meeting_location_type,
    bookingprogrammappingstatus AS booking_program_mapping_status,
    CAST(attributionresolvedat AS Nullable(Int64)) AS attribution_resolved_at_ms,
    bookingprogramid AS booking_program_id,
    attributionresolution AS attribution_resolution,
    durationminutes AS duration_minutes,
    utmparams AS utm_params_json,
    assumeNotNull(tenantid) AS tenant_id,
    CAST(operationsstatssyncedat AS Nullable(Int64)) AS operations_stats_synced_at_ms,
    CAST(scheduledat AS Nullable(Int64)) AS scheduled_at_ms,
    status AS status,
    CAST(fathomlinksavedat AS Nullable(Int64)) AS fathom_link_saved_at_ms,
    fathomlink AS fathom_link,
    CAST(canceledat AS Nullable(Int64)) AS canceled_at_ms,
    rescheduledfrommeetingid AS rescheduled_from_meeting_id,
    noshowsource AS no_show_source,
    CAST(noshowmarkedat AS Nullable(Int64)) AS no_show_marked_at_ms,
    noshowmarkedbyuserid AS no_show_marked_by_user_id,
    noshowreason AS no_show_reason,
    soldprogramid AS sold_program_id,
    soldprogramname AS sold_program_name,
    zoomjoinurl AS zoom_join_url,
    noshownote AS no_show_note,
    CAST(heldmarkedat AS Nullable(Int64)) AS held_marked_at_ms,
    CAST(NULL AS Nullable(String)) AS reassigned_from_closer_id
FROM convex_app.meetings FINAL
WHERE NOT _fivetran_deleted;

-- paymentRecords
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
    recordedbyuserid AS recorded_by_user_id,
    programid AS program_id,
    status AS status,
    prooffileid AS proof_file_id,
    CAST(NULL AS Nullable(String)) AS reference_code,
    CAST(NULL AS Nullable(String)) AS fathom_link,
    CAST(NULL AS Nullable(Int64)) AS verified_at_ms,
    CAST(NULL AS Nullable(String)) AS verified_by_user_id
FROM convex_app.paymentrecords FINAL
WHERE NOT _fivetran_deleted;

-- opportunities
CREATE OR REPLACE VIEW analytics.deals
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    CAST(latestactivityat AS Nullable(Int64)) AS latest_activity_at_ms,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    qualifiedby AS qualified_by_json,
    assumeNotNull(tenantid) AS tenant_id,
    CAST(qualifiedat AS Nullable(Int64)) AS qualified_at_ms,
    source AS source,
    leadid AS lead_id,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms,
    firstbookingprogrammappingstatus AS first_booking_program_mapping_status,
    assignedcloserid AS assigned_closer_id,
    CAST(latestmeetingat AS Nullable(Int64)) AS latest_meeting_at_ms,
    canceledby AS canceled_by,
    firstmeetingid AS first_meeting_id,
    CAST(firstmeetingat AS Nullable(Int64)) AS first_meeting_at_ms,
    eventtypeconfigid AS event_type_config_id,
    calendlyeventuri AS calendly_event_uri,
    firstbookingprogramname AS first_booking_program_name,
    hostcalendlyname AS host_calendly_name,
    CAST(firstbookedat AS Nullable(Int64)) AS first_booked_at_ms,
    latestmeetingid AS latest_meeting_id,
    utmparams AS utm_params_json,
    firstbookingprogramid AS first_booking_program_id,
    hostcalendlyuseruri AS host_calendly_user_uri,
    nextmeetingid AS next_meeting_id,
    CAST(nextmeetingat AS Nullable(Int64)) AS next_meeting_at_ms,
    lostbyuserid AS lost_by_user_id,
    CAST(lostat AS Nullable(Int64)) AS lost_at_ms,
    CAST(paymentreceivedat AS Nullable(Int64)) AS payment_received_at_ms,
    lostreason AS lost_reason,
    cancellationreason AS cancellation_reason,
    soldprogramid AS sold_program_id,
    soldprogramname AS sold_program_name,
    potentialduplicateleadid AS potential_duplicate_lead_id,
    firsttouch AS first_touch_json,
    latesttouch AS latest_touch_json,
    outcome AS outcome,
    stage AS stage
FROM convex_app.opportunities FINAL
WHERE NOT _fivetran_deleted;

-- dealAttributions
CREATE OR REPLACE VIEW analytics.attributions
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    opportunityid AS opportunity_id,
    CAST(attributedat AS Nullable(Int64)) AS attributed_at_ms,
    role AS role,
    teammemberid AS team_member_id,
    assumeNotNull(tenantid) AS tenant_id,
    source AS source,
    CAST(meetingscheduledat AS Nullable(Int64)) AS meeting_scheduled_at_ms,
    teamid AS team_id,
    meetingid AS meeting_id
FROM convex_app.dealattributions FINAL
WHERE NOT _fivetran_deleted;

-- leadGenSubmissions
-- Not synced yet, NULL until Fivetran adds the column: voidedat, voidedbyuserid, voidreason
CREATE OR REPLACE VIEW analytics.captures
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    prospectid AS prospect_id,
    originrankable AS origin_rankable,
    workerid AS worker_id,
    source AS source,
    userid AS user_id,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    originkind AS origin_kind,
    teamid AS team_id,
    assumeNotNull(tenantid) AS tenant_id,
    CAST(submittedat AS Nullable(Int64)) AS submitted_at_ms,
    originvalue AS origin_value,
    CAST(NULL AS Nullable(Int64)) AS voided_at_ms,
    CAST(NULL AS Nullable(String)) AS voided_by_user_id,
    CAST(NULL AS Nullable(String)) AS void_reason
FROM convex_app.leadgensubmissions FINAL
WHERE NOT _fivetran_deleted;

-- leadGenProspects
CREATE OR REPLACE VIEW analytics.prospects
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    lastsubmittedbyworkerid AS last_submitted_by_worker_id,
    CAST(firstcapturedat AS Nullable(Int64)) AS first_captured_at_ms,
    CAST(lastsubmittedat AS Nullable(Int64)) AS last_submitted_at_ms,
    latestoriginkind AS latest_origin_kind,
    firstsource AS first_source,
    latestsource AS latest_source,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    latestoriginvalue AS latest_origin_value,
    contactattemptcount AS contact_attempt_count,
    firstcapturedbyworkerid AS first_captured_by_worker_id,
    assumeNotNull(tenantid) AS tenant_id,
    distinctworkercount AS distinct_worker_count,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms,
    currentauditmatchid AS current_audit_match_id,
    leadid AS lead_id
FROM convex_app.leadgenprospects FINAL
WHERE NOT _fivetran_deleted;

-- domainEvents
CREATE OR REPLACE VIEW analytics.events
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    metadata AS metadata,
    CAST(occurredat AS Nullable(Int64)) AS occurred_at_ms,
    tostatus AS to_status,
    entitytype AS entity_type,
    assumeNotNull(tenantid) AS tenant_id,
    entityid AS entity_id,
    eventtype AS event_type,
    source AS source,
    fromstatus AS from_status,
    reason AS reason,
    actoruserid AS actor_user_id,
    teammemberid AS team_member_id,
    leadid AS lead_id
FROM convex_app.domainevents FINAL
WHERE NOT _fivetran_deleted;

-- slackQualificationEvents
CREATE OR REPLACE VIEW analytics.qualifications
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    slackteamid AS slack_team_id,
    platform AS platform,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    opportunityid AS opportunity_id,
    slackuserid AS slack_user_id,
    qualifiedby AS qualified_by_json,
    resultkind AS result_kind,
    assumeNotNull(tenantid) AS tenant_id,
    installationid AS installation_id,
    CAST(submittedat AS Nullable(Int64)) AS submitted_at_ms,
    fullnamesnapshot AS full_name_snapshot,
    leadid AS lead_id,
    countrysnapshot AS country_snapshot,
    leadtypesnapshot AS lead_type_snapshot
FROM convex_app.slackqualificationevents FINAL
WHERE NOT _fivetran_deleted;

-- operationsQualificationRows
CREATE OR REPLACE VIEW analytics.qualification_rows
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    slackteamid AS slack_team_id,
    bookingprogrammappingstatus AS booking_program_mapping_status,
    bookingprogramname AS booking_program_name,
    assignedcloserid AS assigned_closer_id,
    qualificationeventid AS qualification_event_id,
    CAST(qualifiedat AS Nullable(Int64)) AS qualified_at_ms,
    bookingprogramid AS booking_program_id,
    CAST(firstbookedat AS Nullable(Int64)) AS first_booked_at_ms,
    firstmeetingid AS first_meeting_id,
    opportunityid AS opportunity_id,
    slackuserid AS slack_user_id,
    CAST(firstmeetingat AS Nullable(Int64)) AS first_meeting_at_ms,
    resultkind AS result_kind,
    assumeNotNull(tenantid) AS tenant_id,
    leadid AS lead_id,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms,
    soldprogramid AS sold_program_id,
    soldprogramname AS sold_program_name,
    dealoutcome AS deal_outcome,
    dealstage AS deal_stage
FROM convex_app.operationsqualificationrows FINAL
WHERE NOT _fivetran_deleted;

-- followUps
CREATE OR REPLACE VIEW analytics.followups
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    createdbyuserid AS created_by_user_id,
    reason AS reason,
    type AS type,
    createdsource AS created_source,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    opportunityid AS opportunity_id,
    closerid AS closer_id,
    assumeNotNull(tenantid) AS tenant_id,
    CAST(reminderscheduledat AS Nullable(Int64)) AS reminder_scheduled_at_ms,
    contactmethod AS contact_method,
    leadid AS lead_id,
    status AS status,
    CAST(completedat AS Nullable(Int64)) AS completed_at_ms,
    completionoutcome AS completion_outcome,
    calendlyeventuri AS calendly_event_uri,
    CAST(bookedat AS Nullable(Int64)) AS booked_at_ms
FROM convex_app.followups FINAL
WHERE NOT _fivetran_deleted;

-- resparkBatchItems
CREATE OR REPLACE VIEW analytics.respark_items
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    bucket AS bucket,
    workerid AS worker_id,
    CAST(helduntil AS Nullable(Int64)) AS held_until_ms,
    assumeNotNull(tenantid) AS tenant_id,
    position AS position,
    batchid AS batch_id,
    userid AS user_id,
    leadid AS lead_id,
    result AS result,
    CAST(workedat AS Nullable(Int64)) AS worked_at_ms,
    eventid AS event_id
FROM convex_app.resparkbatchitems FINAL
WHERE NOT _fivetran_deleted;

-- resparkBatches
CREATE OR REPLACE VIEW analytics.respark_batches
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    requestedsize AS requested_size,
    workerid AS worker_id,
    CAST(helduntil AS Nullable(Int64)) AS held_until_ms,
    size AS size,
    assumeNotNull(tenantid) AS tenant_id,
    userid AS user_id,
    teamid AS team_id,
    CAST(completedat AS Nullable(Int64)) AS completed_at_ms
FROM convex_app.resparkbatches FINAL
WHERE NOT _fivetran_deleted;

-- enrollments
-- Not synced yet, NULL until Fivetran adds the column: statuschangedat, statuschangedbyuserid
CREATE OR REPLACE VIEW analytics.enrollments
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    opportunityid AS opportunity_id,
    assumeNotNull(tenantid) AS tenant_id,
    programid AS program_id,
    CAST(enrolledat AS Nullable(Int64)) AS enrolled_at_ms,
    leadid AS lead_id,
    status AS status,
    CAST(NULL AS Nullable(Int64)) AS status_changed_at_ms,
    CAST(NULL AS Nullable(String)) AS status_changed_by_user_id
FROM convex_app.enrollments FINAL
WHERE NOT _fivetran_deleted;

-- meetingFormResponses
CREATE OR REPLACE VIEW analytics.form_answers
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    opportunityid AS opportunity_id,
    answertext AS answer_text,
    fieldkey AS field_key,
    eventtypeconfigid AS event_type_config_id,
    assumeNotNull(tenantid) AS tenant_id,
    CAST(capturedat AS Nullable(Int64)) AS captured_at_ms,
    meetingid AS meeting_id,
    questionlabelsnapshot AS question_label_snapshot,
    fieldcatalogid AS field_catalog_id,
    leadid AS lead_id
FROM convex_app.meetingformresponses FINAL
WHERE NOT _fivetran_deleted;

-- eventTypeFieldCatalog
CREATE OR REPLACE VIEW analytics.form_fields
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    CAST(lastseenat AS Nullable(Int64)) AS last_seen_at_ms,
    currentlabel AS current_label,
    fieldkey AS field_key,
    eventtypeconfigid AS event_type_config_id,
    valuetype AS value_type,
    assumeNotNull(tenantid) AS tenant_id,
    CAST(firstseenat AS Nullable(Int64)) AS first_seen_at_ms
FROM convex_app.eventtypefieldcatalog FINAL
WHERE NOT _fivetran_deleted;

-- leads
-- Not synced yet, NULL until Fivetran adds the column: initialsource, lifecyclestagemovedbackat
CREATE OR REPLACE VIEW analytics.people
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    country AS country,
    leadtype AS lead_type,
    assumeNotNull(tenantid) AS tenant_id,
    fullname AS full_name,
    CAST(firstseenat AS Nullable(Int64)) AS first_seen_at_ms,
    status AS status,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms,
    selfreportedincome AS self_reported_income,
    mergedintoleadid AS merged_into_lead_id,
    dispositionsource AS disposition_source,
    lifecyclestageenteredat AS lifecycle_stage_entered_at_json,
    CAST(dispositionsetat AS Nullable(Int64)) AS disposition_set_at_ms,
    disposition AS disposition,
    lifecyclestage AS lifecycle_stage,
    dispositionreason AS disposition_reason,
    firsttouch AS first_touch_json,
    latesttouch AS latest_touch_json,
    resparkgroup AS respark_group,
    lasttouch AS last_touch_json,
    resparkteamid AS respark_team_id,
    CAST(NULL AS Nullable(String)) AS initial_source,
    CAST(NULL AS Nullable(Int64)) AS lifecycle_stage_moved_back_at_ms
FROM convex_app.leads FINAL
WHERE NOT _fivetran_deleted;

-- teamMembers
CREATE OR REPLACE VIEW analytics.team_members
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    displayname AS display_name,
    assumeNotNull(tenantid) AS tenant_id,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms
FROM convex_app.teammembers FINAL
WHERE NOT _fivetran_deleted;

-- users
-- Not synced yet, NULL until Fivetran adds the column: personaleventtypeuri
CREATE OR REPLACE VIEW analytics.users
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    role AS role,
    assumeNotNull(tenantid) AS tenant_id,
    fullname AS full_name,
    isactive AS is_active,
    invitationstatus AS invitation_status,
    CAST(profilepicturesyncedat AS Nullable(Int64)) AS profile_picture_synced_at_ms,
    calendlymembername AS calendly_member_name,
    CAST(customprofilepictureuploadedat AS Nullable(Int64)) AS custom_profile_picture_uploaded_at_ms,
    CAST(deletedat AS Nullable(Int64)) AS deleted_at_ms,
    teammemberid AS team_member_id,
    CAST(NULL AS Nullable(String)) AS personal_event_type_uri
FROM convex_app.users FINAL
WHERE NOT _fivetran_deleted;

-- tenantPrograms
-- Not synced yet, NULL until Fivetran adds the column: description, archivedat
CREATE OR REPLACE VIEW analytics.programs
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    createdbyuserid AS created_by_user_id,
    defaultcurrency AS default_currency,
    name AS name,
    assumeNotNull(tenantid) AS tenant_id,
    normalizedname AS normalized_name,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms,
    CAST(NULL AS Nullable(String)) AS description,
    CAST(NULL AS Nullable(Int64)) AS archived_at_ms
FROM convex_app.tenantprograms FINAL
WHERE NOT _fivetran_deleted;

-- attributionTeams
CREATE OR REPLACE VIEW analytics.teams
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    utmsource AS utm_source,
    displayname AS display_name,
    normalizedutmsource AS normalized_utm_source,
    assumeNotNull(tenantid) AS tenant_id,
    isactive AS is_active,
    slug AS slug,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms,
    bookingdailyquota AS booking_daily_quota
FROM convex_app.attributionteams FINAL
WHERE NOT _fivetran_deleted;

-- dmClosers
-- Not synced yet, NULL until Fivetran adds the column: hourlyrateminor
CREATE OR REPLACE VIEW analytics.dm_closers
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    normalizedutmmedium AS normalized_utm_medium,
    displayname AS display_name,
    teamid AS team_id,
    assumeNotNull(tenantid) AS tenant_id,
    utmmedium AS utm_medium,
    isactive AS is_active,
    slug AS slug,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms,
    userid AS user_id,
    teammemberid AS team_member_id,
    CAST(NULL AS Nullable(Float64)) AS hourly_rate_minor
FROM convex_app.dmclosers FINAL
WHERE NOT _fivetran_deleted;

-- leadGenWorkers
CREATE OR REPLACE VIEW analytics.workers
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    displayname AS display_name,
    teamid AS team_id,
    assumeNotNull(tenantid) AS tenant_id,
    isactive AS is_active,
    userid AS user_id,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms,
    teammemberid AS team_member_id
FROM convex_app.leadgenworkers FINAL
WHERE NOT _fivetran_deleted;

-- slackUsers
-- Not synced yet, NULL until Fivetran adds the column: crmuserid, dailyqualificationquota
CREATE OR REPLACE VIEW analytics.slack_users
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    CAST(lastseenat AS Nullable(Int64)) AS last_seen_at_ms,
    isbot AS is_bot,
    slackteamid AS slack_team_id,
    displayname AS display_name,
    timezone AS timezone,
    CAST(lastsyncedat AS Nullable(Int64)) AS last_synced_at_ms,
    CAST(firstseenat AS Nullable(Int64)) AS first_seen_at_ms,
    realname AS real_name,
    slackuserid AS slack_user_id,
    isdeleted AS is_deleted,
    assumeNotNull(tenantid) AS tenant_id,
    installationid AS installation_id,
    username AS username,
    teammemberid AS team_member_id,
    CAST(NULL AS Nullable(String)) AS crm_user_id,
    CAST(NULL AS Nullable(Float64)) AS daily_qualification_quota
FROM convex_app.slackusers FINAL
WHERE NOT _fivetran_deleted;

-- eventTypeConfigs
-- Not synced yet, NULL until Fivetran adds the column: paymentlinks, calendlydeletedat
CREATE OR REPLACE VIEW analytics.event_types
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    calendlyactive AS calendly_active,
    calendlycreatedat AS calendly_created_at,
    calendlyschedulingurl AS calendly_scheduling_url,
    displayname AS display_name,
    calendlydurationminutes AS calendly_duration_minutes,
    calendlyslug AS calendly_slug,
    displaynamesource AS display_name_source,
    CAST(lastcalendlyseenat AS Nullable(Int64)) AS last_calendly_seen_at_ms,
    calendlykind AS calendly_kind,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    calendlytype AS calendly_type,
    bookingbaseurl AS booking_base_url,
    calendlyprofilename AS calendly_profile_name,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms,
    bookingprogrammappingstatus AS booking_program_mapping_status,
    calendlycolor AS calendly_color,
    calendlyname AS calendly_name,
    calendlyadminmanaged AS calendly_admin_managed,
    calendlysyncstatus AS calendly_sync_status,
    CAST(lastcalendlysyncedat AS Nullable(Int64)) AS last_calendly_synced_at_ms,
    calendlybookingmethod AS calendly_booking_method,
    knowncustomfieldkeys AS known_custom_field_keys_json,
    calendlylocale AS calendly_locale,
    assumeNotNull(tenantid) AS tenant_id,
    calendlyeventtypeuri AS calendly_event_type_uri,
    bookingurlsource AS booking_url_source,
    calendlyowneruri AS calendly_owner_uri,
    calendlyupdatedat AS calendly_updated_at,
    calendlysecret AS calendly_secret,
    customfieldmappings AS custom_field_mappings_json,
    calendlypoolingtype AS calendly_pooling_type,
    bookingprogramname AS booking_program_name,
    linkportalenabled AS link_portal_enabled,
    bookingprogramid AS booking_program_id,
    isextended AS is_extended,
    CAST(NULL AS Nullable(String)) AS payment_links_json,
    CAST(NULL AS Nullable(String)) AS calendly_deleted_at
FROM convex_app.eventtypeconfigs FINAL
WHERE NOT _fivetran_deleted;

-- teamProgramEventTypes
CREATE OR REPLACE VIEW analytics.team_program_event_types
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    mode AS mode,
    CAST(createdat AS Nullable(Int64)) AS created_at_ms,
    eventtypeconfigid AS event_type_config_id,
    teamid AS team_id,
    assumeNotNull(tenantid) AS tenant_id,
    programid AS program_id,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms
FROM convex_app.teamprogrameventtypes FINAL
WHERE NOT _fivetran_deleted;

-- leadGenWorkerSchedules
CREATE OR REPLACE VIEW analytics.worker_schedules
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    workerid AS worker_id,
    assumeNotNull(tenantid) AS tenant_id,
    weekday AS weekday,
    updatedbyuserid AS updated_by_user_id,
    userid AS user_id,
    scheduledhours AS scheduled_hours,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms
FROM convex_app.leadgenworkerschedules FINAL
WHERE NOT _fivetran_deleted;

-- slackQualifierSchedules
CREATE OR REPLACE VIEW analytics.slack_qualifier_schedules
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    slackuserid AS slack_user_id,
    assumeNotNull(tenantid) AS tenant_id,
    weekday AS weekday,
    updatedbyuserid AS updated_by_user_id,
    scheduledhours AS scheduled_hours,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms
FROM convex_app.slackqualifierschedules FINAL
WHERE NOT _fivetran_deleted;

-- dmCloserSchedules
CREATE OR REPLACE VIEW analytics.dm_closer_schedules
DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT
    _id AS id,
    toUnixTimestamp64Milli(_creationtime) AS creation_time_ms,
    assumeNotNull(tenantid) AS tenant_id,
    weekday AS weekday,
    updatedbyuserid AS updated_by_user_id,
    dmcloserid AS dm_closer_id,
    scheduledhours AS scheduled_hours,
    CAST(updatedat AS Nullable(Int64)) AS updated_at_ms
FROM convex_app.dmcloserschedules FINAL
WHERE NOT _fivetran_deleted;
