/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin_billingOps from "../admin/billingOps.js";
import type * as admin_inviteCleanup from "../admin/inviteCleanup.js";
import type * as admin_inviteCleanupMutations from "../admin/inviteCleanupMutations.js";
import type * as admin_meetingActions from "../admin/meetingActions.js";
import type * as admin_migrations from "../admin/migrations.js";
import type * as admin_rawWebhookReplay from "../admin/rawWebhookReplay.js";
import type * as admin_supportTickets from "../admin/supportTickets.js";
import type * as admin_tenants from "../admin/tenants.js";
import type * as admin_tenantsMutations from "../admin/tenantsMutations.js";
import type * as admin_tenantsQueries from "../admin/tenantsQueries.js";
import type * as attribution_backfills from "../attribution/backfills.js";
import type * as attribution_dmClosers from "../attribution/dmClosers.js";
import type * as attribution_teams from "../attribution/teams.js";
import type * as auth from "../auth.js";
import type * as billing_aggregates from "../billing/aggregates.js";
import type * as billing_audit from "../billing/audit.js";
import type * as billing_backfill from "../billing/backfill.js";
import type * as billing_enrichment from "../billing/enrichment.js";
import type * as billing_export from "../billing/export.js";
import type * as billing_guards from "../billing/guards.js";
import type * as billing_mutations from "../billing/mutations.js";
import type * as billing_queries from "../billing/queries.js";
import type * as billing_queryBuilder from "../billing/queryBuilder.js";
import type * as billing_types from "../billing/types.js";
import type * as billing_validators from "../billing/validators.js";
import type * as calendly_connectionQueries from "../calendly/connectionQueries.js";
import type * as calendly_eventTypeMutations from "../calendly/eventTypeMutations.js";
import type * as calendly_eventTypes from "../calendly/eventTypes.js";
import type * as calendly_healthCheck from "../calendly/healthCheck.js";
import type * as calendly_healthCheckMutations from "../calendly/healthCheckMutations.js";
import type * as calendly_oauth from "../calendly/oauth.js";
import type * as calendly_oauthMutations from "../calendly/oauthMutations.js";
import type * as calendly_oauthQueries from "../calendly/oauthQueries.js";
import type * as calendly_orgMembers from "../calendly/orgMembers.js";
import type * as calendly_orgMembersMutations from "../calendly/orgMembersMutations.js";
import type * as calendly_orgMembersQueries from "../calendly/orgMembersQueries.js";
import type * as calendly_tokenMutations from "../calendly/tokenMutations.js";
import type * as calendly_tokens from "../calendly/tokens.js";
import type * as calendly_webhookSetup from "../calendly/webhookSetup.js";
import type * as calendly_webhookSetupMutations from "../calendly/webhookSetupMutations.js";
import type * as closer_calendar from "../closer/calendar.js";
import type * as closer_dashboard from "../closer/dashboard.js";
import type * as closer_followUp from "../closer/followUp.js";
import type * as closer_followUpMutations from "../closer/followUpMutations.js";
import type * as closer_followUpQueries from "../closer/followUpQueries.js";
import type * as closer_meetingActions from "../closer/meetingActions.js";
import type * as closer_meetingComments from "../closer/meetingComments.js";
import type * as closer_meetingDetail from "../closer/meetingDetail.js";
import type * as closer_noShowActions from "../closer/noShowActions.js";
import type * as closer_payments from "../closer/payments.js";
import type * as closer_pipeline from "../closer/pipeline.js";
import type * as closer_reminderDetail from "../closer/reminderDetail.js";
import type * as closer_reminderOutcomes from "../closer/reminderOutcomes.js";
import type * as crons from "../crons.js";
import type * as customers_conversion from "../customers/conversion.js";
import type * as customers_mutations from "../customers/mutations.js";
import type * as customers_queries from "../customers/queries.js";
import type * as dashboard_adminStats from "../dashboard/adminStats.js";
import type * as dashboard_overview from "../dashboard/overview.js";
import type * as dashboard_overviewBuilders from "../dashboard/overviewBuilders.js";
import type * as dashboard_overviewLeadGen from "../dashboard/overviewLeadGen.js";
import type * as dashboard_overviewOperations from "../dashboard/overviewOperations.js";
import type * as dashboard_overviewOrigins from "../dashboard/overviewOrigins.js";
import type * as dashboard_overviewRange from "../dashboard/overviewRange.js";
import type * as dashboard_overviewSlack from "../dashboard/overviewSlack.js";
import type * as dashboard_overviewTypes from "../dashboard/overviewTypes.js";
import type * as eventTypeConfigs_mutations from "../eventTypeConfigs/mutations.js";
import type * as eventTypeConfigs_queries from "../eventTypeConfigs/queries.js";
import type * as http from "../http.js";
import type * as leadCustomers_activity from "../leadCustomers/activity.js";
import type * as leadCustomers_detail from "../leadCustomers/detail.js";
import type * as leadCustomers_detailPayload from "../leadCustomers/detailPayload.js";
import type * as leadCustomers_identifierResolution from "../leadCustomers/identifierResolution.js";
import type * as leadCustomers_permissions from "../leadCustomers/permissions.js";
import type * as leadCustomers_projection from "../leadCustomers/projection.js";
import type * as leadCustomers_queries from "../leadCustomers/queries.js";
import type * as leadCustomers_searchText from "../leadCustomers/searchText.js";
import type * as leadCustomers_types from "../leadCustomers/types.js";
import type * as leadCustomers_validators from "../leadCustomers/validators.js";
import type * as leadGen_activity from "../leadGen/activity.js";
import type * as leadGen_aggregates from "../leadGen/aggregates.js";
import type * as leadGen_auditMatching from "../leadGen/auditMatching.js";
import type * as leadGen_auditQueries from "../leadGen/auditQueries.js";
import type * as leadGen_backfills from "../leadGen/backfills.js";
import type * as leadGen_capture from "../leadGen/capture.js";
import type * as leadGen_corrections from "../leadGen/corrections.js";
import type * as leadGen_exports from "../leadGen/exports.js";
import type * as leadGen_normalization from "../leadGen/normalization.js";
import type * as leadGen_reconciliation from "../leadGen/reconciliation.js";
import type * as leadGen_reportBuilders from "../leadGen/reportBuilders.js";
import type * as leadGen_reportLimits from "../leadGen/reportLimits.js";
import type * as leadGen_reportReaders from "../leadGen/reportReaders.js";
import type * as leadGen_reporting from "../leadGen/reporting.js";
import type * as leadGen_schedules from "../leadGen/schedules.js";
import type * as leadGen_settings from "../leadGen/settings.js";
import type * as leadGen_sharedTeams from "../leadGen/sharedTeams.js";
import type * as leadGen_validators from "../leadGen/validators.js";
import type * as leadGen_workers from "../leadGen/workers.js";
import type * as leads_identityResolution from "../leads/identityResolution.js";
import type * as leads_merge from "../leads/merge.js";
import type * as leads_mutations from "../leads/mutations.js";
import type * as leads_queries from "../leads/queries.js";
import type * as leads_searchTextBuilder from "../leads/searchTextBuilder.js";
import type * as lib_activeFollowUp from "../lib/activeFollowUp.js";
import type * as lib_attribution_detailPayload from "../lib/attribution/detailPayload.js";
import type * as lib_attribution_normalize from "../lib/attribution/normalize.js";
import type * as lib_attribution_resolveAttribution from "../lib/attribution/resolveAttribution.js";
import type * as lib_attribution_teamInput from "../lib/attribution/teamInput.js";
import type * as lib_attribution_validators from "../lib/attribution/validators.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_domainEvents from "../lib/domainEvents.js";
import type * as lib_domainEventsAction from "../lib/domainEventsAction.js";
import type * as lib_domainEventsInternal from "../lib/domainEventsInternal.js";
import type * as lib_eventTypeBookability from "../lib/eventTypeBookability.js";
import type * as lib_eventTypeFields from "../lib/eventTypeFields.js";
import type * as lib_formatMoney from "../lib/formatMoney.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_inviteToken from "../lib/inviteToken.js";
import type * as lib_leadDisplay from "../lib/leadDisplay.js";
import type * as lib_linkPortal_validators from "../lib/linkPortal/validators.js";
import type * as lib_meetingFormResponses from "../lib/meetingFormResponses.js";
import type * as lib_meetingLocation from "../lib/meetingLocation.js";
import type * as lib_meetingOutcomeCompletion from "../lib/meetingOutcomeCompletion.js";
import type * as lib_normalization from "../lib/normalization.js";
import type * as lib_opportunityActivity from "../lib/opportunityActivity.js";
import type * as lib_opportunityMeetingRefs from "../lib/opportunityMeetingRefs.js";
import type * as lib_opportunitySearch from "../lib/opportunitySearch.js";
import type * as lib_outcomeEligibility from "../lib/outcomeEligibility.js";
import type * as lib_payloadExtraction from "../lib/payloadExtraction.js";
import type * as lib_paymentHelpers from "../lib/paymentHelpers.js";
import type * as lib_paymentTypes from "../lib/paymentTypes.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_roleMapping from "../lib/roleMapping.js";
import type * as lib_sideDeals from "../lib/sideDeals.js";
import type * as lib_slackBlockKit from "../lib/slackBlockKit.js";
import type * as lib_slackOAuthState from "../lib/slackOAuthState.js";
import type * as lib_slackSignature from "../lib/slackSignature.js";
import type * as lib_socialPlatform from "../lib/socialPlatform.js";
import type * as lib_soldProgramCache from "../lib/soldProgramCache.js";
import type * as lib_staleOpportunityNudges from "../lib/staleOpportunityNudges.js";
import type * as lib_statusTransitions from "../lib/statusTransitions.js";
import type * as lib_syncCustomerSnapshot from "../lib/syncCustomerSnapshot.js";
import type * as lib_syncLeadMeetingNames from "../lib/syncLeadMeetingNames.js";
import type * as lib_syncOpportunityMeetingsAssignedCloser from "../lib/syncOpportunityMeetingsAssignedCloser.js";
import type * as lib_tenantCalendlyConnection from "../lib/tenantCalendlyConnection.js";
import type * as lib_tenantStatsHelper from "../lib/tenantStatsHelper.js";
import type * as lib_unavailabilityValidation from "../lib/unavailabilityValidation.js";
import type * as lib_userLookup from "../lib/userLookup.js";
import type * as lib_utmParams from "../lib/utmParams.js";
import type * as lib_validation from "../lib/validation.js";
import type * as lib_workosUserId from "../lib/workosUserId.js";
import type * as linkPortal_authz from "../linkPortal/authz.js";
import type * as linkPortal_campaignMutations from "../linkPortal/campaignMutations.js";
import type * as linkPortal_campaignQueries from "../linkPortal/campaignQueries.js";
import type * as linkPortal_configMutations from "../linkPortal/configMutations.js";
import type * as linkPortal_configQueries from "../linkPortal/configQueries.js";
import type * as linkPortal_copyActions from "../linkPortal/copyActions.js";
import type * as linkPortal_copyMutations from "../linkPortal/copyMutations.js";
import type * as linkPortal_copyQueries from "../linkPortal/copyQueries.js";
import type * as linkPortal_passwordActions from "../linkPortal/passwordActions.js";
import type * as linkPortal_portalActions from "../linkPortal/portalActions.js";
import type * as linkPortal_portalQueries from "../linkPortal/portalQueries.js";
import type * as linkPortal_rateLimitMutations from "../linkPortal/rateLimitMutations.js";
import type * as linkPortal_sessionToken from "../linkPortal/sessionToken.js";
import type * as linkPortal_slugActions from "../linkPortal/slugActions.js";
import type * as meetings_maintenance from "../meetings/maintenance.js";
import type * as migrations from "../migrations.js";
import type * as onboarding_complete from "../onboarding/complete.js";
import type * as onboarding_invite from "../onboarding/invite.js";
import type * as operations_bookingHealth from "../operations/bookingHealth.js";
import type * as operations_meetingStats from "../operations/meetingStats.js";
import type * as operations_phoneSales from "../operations/phoneSales.js";
import type * as operations_projections from "../operations/projections.js";
import type * as operations_qualifications from "../operations/qualifications.js";
import type * as operations_scheduling from "../operations/scheduling.js";
import type * as operations_unmappedUtms from "../operations/unmappedUtms.js";
import type * as operations_validators from "../operations/validators.js";
import type * as opportunities_createManual from "../opportunities/createManual.js";
import type * as opportunities_detailQuery from "../opportunities/detailQuery.js";
import type * as opportunities_listQueries from "../opportunities/listQueries.js";
import type * as opportunities_maintenance from "../opportunities/maintenance.js";
import type * as opportunities_queries from "../opportunities/queries.js";
import type * as opportunities_staleness from "../opportunities/staleness.js";
import type * as opportunities_validators from "../opportunities/validators.js";
import type * as pipeline_inviteeCanceled from "../pipeline/inviteeCanceled.js";
import type * as pipeline_inviteeCreated from "../pipeline/inviteeCreated.js";
import type * as pipeline_inviteeNoShow from "../pipeline/inviteeNoShow.js";
import type * as pipeline_mutations from "../pipeline/mutations.js";
import type * as pipeline_processor from "../pipeline/processor.js";
import type * as pipeline_queries from "../pipeline/queries.js";
import type * as pipeline_reminderDetail from "../pipeline/reminderDetail.js";
import type * as pipeline_slackJoinLookup from "../pipeline/slackJoinLookup.js";
import type * as reporting_activityFeed from "../reporting/activityFeed.js";
import type * as reporting_aggregates from "../reporting/aggregates.js";
import type * as reporting_backfill from "../reporting/backfill.js";
import type * as reporting_bookedVsSold from "../reporting/bookedVsSold.js";
import type * as reporting_formResponseAnalytics from "../reporting/formResponseAnalytics.js";
import type * as reporting_leadConversion from "../reporting/leadConversion.js";
import type * as reporting_lib_eventLabels from "../reporting/lib/eventLabels.js";
import type * as reporting_lib_helpers from "../reporting/lib/helpers.js";
import type * as reporting_lib_hondurasBusinessTime from "../reporting/lib/hondurasBusinessTime.js";
import type * as reporting_lib_outcomeDerivation from "../reporting/lib/outcomeDerivation.js";
import type * as reporting_lib_periodBucketing from "../reporting/lib/periodBucketing.js";
import type * as reporting_lib_programDimensions from "../reporting/lib/programDimensions.js";
import type * as reporting_lib_slackQualificationBreakdown from "../reporting/lib/slackQualificationBreakdown.js";
import type * as reporting_lib_slackQualificationLedger from "../reporting/lib/slackQualificationLedger.js";
import type * as reporting_pipelineHealth from "../reporting/pipelineHealth.js";
import type * as reporting_remindersReporting from "../reporting/remindersReporting.js";
import type * as reporting_revenue from "../reporting/revenue.js";
import type * as reporting_revenueTrend from "../reporting/revenueTrend.js";
import type * as reporting_slackQualifications from "../reporting/slackQualifications.js";
import type * as reporting_teamActions from "../reporting/teamActions.js";
import type * as reporting_teamOutcomes from "../reporting/teamOutcomes.js";
import type * as reporting_teamPerformance from "../reporting/teamPerformance.js";
import type * as reporting_verification from "../reporting/verification.js";
import type * as reporting_writeHooks from "../reporting/writeHooks.js";
import type * as requireSystemAdmin from "../requireSystemAdmin.js";
import type * as requireTenantUser from "../requireTenantUser.js";
import type * as requireTenantUserFromAction from "../requireTenantUserFromAction.js";
import type * as sideDeals_deleteEmptyOpportunity from "../sideDeals/deleteEmptyOpportunity.js";
import type * as sideDeals_logPayment from "../sideDeals/logPayment.js";
import type * as sideDeals_markLost from "../sideDeals/markLost.js";
import type * as sideDeals_voidPayment from "../sideDeals/voidPayment.js";
import type * as slack_channels from "../slack/channels.js";
import type * as slack_channelsActions from "../slack/channelsActions.js";
import type * as slack_cleanup from "../slack/cleanup.js";
import type * as slack_commands from "../slack/commands.js";
import type * as slack_createQualifiedLead from "../slack/createQualifiedLead.js";
import type * as slack_deepLinks from "../slack/deepLinks.js";
import type * as slack_events from "../slack/events.js";
import type * as slack_inboundStubs from "../slack/inboundStubs.js";
import type * as slack_installations from "../slack/installations.js";
import type * as slack_interactivity from "../slack/interactivity.js";
import type * as slack_metrics from "../slack/metrics.js";
import type * as slack_notify from "../slack/notify.js";
import type * as slack_notifyData from "../slack/notifyData.js";
import type * as slack_oauth from "../slack/oauth.js";
import type * as slack_oauthStateMutations from "../slack/oauthStateMutations.js";
import type * as slack_profileNames from "../slack/profileNames.js";
import type * as slack_rawEvents from "../slack/rawEvents.js";
import type * as slack_rawEventsAudit from "../slack/rawEventsAudit.js";
import type * as slack_refreshCron from "../slack/refreshCron.js";
import type * as slack_staleReminders from "../slack/staleReminders.js";
import type * as slack_staleRemindersData from "../slack/staleRemindersData.js";
import type * as slack_tokens from "../slack/tokens.js";
import type * as slack_userActions from "../slack/userActions.js";
import type * as slack_users from "../slack/users.js";
import type * as slack_webApi from "../slack/webApi.js";
import type * as support from "../support.js";
import type * as tenantPrograms_mutations from "../tenantPrograms/mutations.js";
import type * as tenantPrograms_queries from "../tenantPrograms/queries.js";
import type * as tenantPrograms_seed from "../tenantPrograms/seed.js";
import type * as tenantPrograms_shared from "../tenantPrograms/shared.js";
import type * as tenantPrograms_sync from "../tenantPrograms/sync.js";
import type * as tenants from "../tenants.js";
import type * as testing_calendly from "../testing/calendly.js";
import type * as testing_e2e from "../testing/e2e.js";
import type * as testing_operationalData from "../testing/operationalData.js";
import type * as unavailability_mutations from "../unavailability/mutations.js";
import type * as unavailability_queries from "../unavailability/queries.js";
import type * as unavailability_redistribution from "../unavailability/redistribution.js";
import type * as unavailability_shared from "../unavailability/shared.js";
import type * as users_assignPersonalEventType from "../users/assignPersonalEventType.js";
import type * as users_linkCalendlyMember from "../users/linkCalendlyMember.js";
import type * as users_queries from "../users/queries.js";
import type * as webhooks_calendly from "../webhooks/calendly.js";
import type * as webhooks_calendlyMutations from "../webhooks/calendlyMutations.js";
import type * as webhooks_calendlyQueries from "../webhooks/calendlyQueries.js";
import type * as webhooks_cleanup from "../webhooks/cleanup.js";
import type * as webhooks_cleanupMutations from "../webhooks/cleanupMutations.js";
import type * as workos_roles from "../workos/roles.js";
import type * as workos_userActions from "../workos/userActions.js";
import type * as workos_userManagement from "../workos/userManagement.js";
import type * as workos_userMutations from "../workos/userMutations.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "admin/billingOps": typeof admin_billingOps;
  "admin/inviteCleanup": typeof admin_inviteCleanup;
  "admin/inviteCleanupMutations": typeof admin_inviteCleanupMutations;
  "admin/meetingActions": typeof admin_meetingActions;
  "admin/migrations": typeof admin_migrations;
  "admin/rawWebhookReplay": typeof admin_rawWebhookReplay;
  "admin/supportTickets": typeof admin_supportTickets;
  "admin/tenants": typeof admin_tenants;
  "admin/tenantsMutations": typeof admin_tenantsMutations;
  "admin/tenantsQueries": typeof admin_tenantsQueries;
  "attribution/backfills": typeof attribution_backfills;
  "attribution/dmClosers": typeof attribution_dmClosers;
  "attribution/teams": typeof attribution_teams;
  auth: typeof auth;
  "billing/aggregates": typeof billing_aggregates;
  "billing/audit": typeof billing_audit;
  "billing/backfill": typeof billing_backfill;
  "billing/enrichment": typeof billing_enrichment;
  "billing/export": typeof billing_export;
  "billing/guards": typeof billing_guards;
  "billing/mutations": typeof billing_mutations;
  "billing/queries": typeof billing_queries;
  "billing/queryBuilder": typeof billing_queryBuilder;
  "billing/types": typeof billing_types;
  "billing/validators": typeof billing_validators;
  "calendly/connectionQueries": typeof calendly_connectionQueries;
  "calendly/eventTypeMutations": typeof calendly_eventTypeMutations;
  "calendly/eventTypes": typeof calendly_eventTypes;
  "calendly/healthCheck": typeof calendly_healthCheck;
  "calendly/healthCheckMutations": typeof calendly_healthCheckMutations;
  "calendly/oauth": typeof calendly_oauth;
  "calendly/oauthMutations": typeof calendly_oauthMutations;
  "calendly/oauthQueries": typeof calendly_oauthQueries;
  "calendly/orgMembers": typeof calendly_orgMembers;
  "calendly/orgMembersMutations": typeof calendly_orgMembersMutations;
  "calendly/orgMembersQueries": typeof calendly_orgMembersQueries;
  "calendly/tokenMutations": typeof calendly_tokenMutations;
  "calendly/tokens": typeof calendly_tokens;
  "calendly/webhookSetup": typeof calendly_webhookSetup;
  "calendly/webhookSetupMutations": typeof calendly_webhookSetupMutations;
  "closer/calendar": typeof closer_calendar;
  "closer/dashboard": typeof closer_dashboard;
  "closer/followUp": typeof closer_followUp;
  "closer/followUpMutations": typeof closer_followUpMutations;
  "closer/followUpQueries": typeof closer_followUpQueries;
  "closer/meetingActions": typeof closer_meetingActions;
  "closer/meetingComments": typeof closer_meetingComments;
  "closer/meetingDetail": typeof closer_meetingDetail;
  "closer/noShowActions": typeof closer_noShowActions;
  "closer/payments": typeof closer_payments;
  "closer/pipeline": typeof closer_pipeline;
  "closer/reminderDetail": typeof closer_reminderDetail;
  "closer/reminderOutcomes": typeof closer_reminderOutcomes;
  crons: typeof crons;
  "customers/conversion": typeof customers_conversion;
  "customers/mutations": typeof customers_mutations;
  "customers/queries": typeof customers_queries;
  "dashboard/adminStats": typeof dashboard_adminStats;
  "dashboard/overview": typeof dashboard_overview;
  "dashboard/overviewBuilders": typeof dashboard_overviewBuilders;
  "dashboard/overviewLeadGen": typeof dashboard_overviewLeadGen;
  "dashboard/overviewOperations": typeof dashboard_overviewOperations;
  "dashboard/overviewOrigins": typeof dashboard_overviewOrigins;
  "dashboard/overviewRange": typeof dashboard_overviewRange;
  "dashboard/overviewSlack": typeof dashboard_overviewSlack;
  "dashboard/overviewTypes": typeof dashboard_overviewTypes;
  "eventTypeConfigs/mutations": typeof eventTypeConfigs_mutations;
  "eventTypeConfigs/queries": typeof eventTypeConfigs_queries;
  http: typeof http;
  "leadCustomers/activity": typeof leadCustomers_activity;
  "leadCustomers/detail": typeof leadCustomers_detail;
  "leadCustomers/detailPayload": typeof leadCustomers_detailPayload;
  "leadCustomers/identifierResolution": typeof leadCustomers_identifierResolution;
  "leadCustomers/permissions": typeof leadCustomers_permissions;
  "leadCustomers/projection": typeof leadCustomers_projection;
  "leadCustomers/queries": typeof leadCustomers_queries;
  "leadCustomers/searchText": typeof leadCustomers_searchText;
  "leadCustomers/types": typeof leadCustomers_types;
  "leadCustomers/validators": typeof leadCustomers_validators;
  "leadGen/activity": typeof leadGen_activity;
  "leadGen/aggregates": typeof leadGen_aggregates;
  "leadGen/auditMatching": typeof leadGen_auditMatching;
  "leadGen/auditQueries": typeof leadGen_auditQueries;
  "leadGen/backfills": typeof leadGen_backfills;
  "leadGen/capture": typeof leadGen_capture;
  "leadGen/corrections": typeof leadGen_corrections;
  "leadGen/exports": typeof leadGen_exports;
  "leadGen/normalization": typeof leadGen_normalization;
  "leadGen/reconciliation": typeof leadGen_reconciliation;
  "leadGen/reportBuilders": typeof leadGen_reportBuilders;
  "leadGen/reportLimits": typeof leadGen_reportLimits;
  "leadGen/reportReaders": typeof leadGen_reportReaders;
  "leadGen/reporting": typeof leadGen_reporting;
  "leadGen/schedules": typeof leadGen_schedules;
  "leadGen/settings": typeof leadGen_settings;
  "leadGen/sharedTeams": typeof leadGen_sharedTeams;
  "leadGen/validators": typeof leadGen_validators;
  "leadGen/workers": typeof leadGen_workers;
  "leads/identityResolution": typeof leads_identityResolution;
  "leads/merge": typeof leads_merge;
  "leads/mutations": typeof leads_mutations;
  "leads/queries": typeof leads_queries;
  "leads/searchTextBuilder": typeof leads_searchTextBuilder;
  "lib/activeFollowUp": typeof lib_activeFollowUp;
  "lib/attribution/detailPayload": typeof lib_attribution_detailPayload;
  "lib/attribution/normalize": typeof lib_attribution_normalize;
  "lib/attribution/resolveAttribution": typeof lib_attribution_resolveAttribution;
  "lib/attribution/teamInput": typeof lib_attribution_teamInput;
  "lib/attribution/validators": typeof lib_attribution_validators;
  "lib/constants": typeof lib_constants;
  "lib/domainEvents": typeof lib_domainEvents;
  "lib/domainEventsAction": typeof lib_domainEventsAction;
  "lib/domainEventsInternal": typeof lib_domainEventsInternal;
  "lib/eventTypeBookability": typeof lib_eventTypeBookability;
  "lib/eventTypeFields": typeof lib_eventTypeFields;
  "lib/formatMoney": typeof lib_formatMoney;
  "lib/identity": typeof lib_identity;
  "lib/inviteToken": typeof lib_inviteToken;
  "lib/leadDisplay": typeof lib_leadDisplay;
  "lib/linkPortal/validators": typeof lib_linkPortal_validators;
  "lib/meetingFormResponses": typeof lib_meetingFormResponses;
  "lib/meetingLocation": typeof lib_meetingLocation;
  "lib/meetingOutcomeCompletion": typeof lib_meetingOutcomeCompletion;
  "lib/normalization": typeof lib_normalization;
  "lib/opportunityActivity": typeof lib_opportunityActivity;
  "lib/opportunityMeetingRefs": typeof lib_opportunityMeetingRefs;
  "lib/opportunitySearch": typeof lib_opportunitySearch;
  "lib/outcomeEligibility": typeof lib_outcomeEligibility;
  "lib/payloadExtraction": typeof lib_payloadExtraction;
  "lib/paymentHelpers": typeof lib_paymentHelpers;
  "lib/paymentTypes": typeof lib_paymentTypes;
  "lib/permissions": typeof lib_permissions;
  "lib/roleMapping": typeof lib_roleMapping;
  "lib/sideDeals": typeof lib_sideDeals;
  "lib/slackBlockKit": typeof lib_slackBlockKit;
  "lib/slackOAuthState": typeof lib_slackOAuthState;
  "lib/slackSignature": typeof lib_slackSignature;
  "lib/socialPlatform": typeof lib_socialPlatform;
  "lib/soldProgramCache": typeof lib_soldProgramCache;
  "lib/staleOpportunityNudges": typeof lib_staleOpportunityNudges;
  "lib/statusTransitions": typeof lib_statusTransitions;
  "lib/syncCustomerSnapshot": typeof lib_syncCustomerSnapshot;
  "lib/syncLeadMeetingNames": typeof lib_syncLeadMeetingNames;
  "lib/syncOpportunityMeetingsAssignedCloser": typeof lib_syncOpportunityMeetingsAssignedCloser;
  "lib/tenantCalendlyConnection": typeof lib_tenantCalendlyConnection;
  "lib/tenantStatsHelper": typeof lib_tenantStatsHelper;
  "lib/unavailabilityValidation": typeof lib_unavailabilityValidation;
  "lib/userLookup": typeof lib_userLookup;
  "lib/utmParams": typeof lib_utmParams;
  "lib/validation": typeof lib_validation;
  "lib/workosUserId": typeof lib_workosUserId;
  "linkPortal/authz": typeof linkPortal_authz;
  "linkPortal/campaignMutations": typeof linkPortal_campaignMutations;
  "linkPortal/campaignQueries": typeof linkPortal_campaignQueries;
  "linkPortal/configMutations": typeof linkPortal_configMutations;
  "linkPortal/configQueries": typeof linkPortal_configQueries;
  "linkPortal/copyActions": typeof linkPortal_copyActions;
  "linkPortal/copyMutations": typeof linkPortal_copyMutations;
  "linkPortal/copyQueries": typeof linkPortal_copyQueries;
  "linkPortal/passwordActions": typeof linkPortal_passwordActions;
  "linkPortal/portalActions": typeof linkPortal_portalActions;
  "linkPortal/portalQueries": typeof linkPortal_portalQueries;
  "linkPortal/rateLimitMutations": typeof linkPortal_rateLimitMutations;
  "linkPortal/sessionToken": typeof linkPortal_sessionToken;
  "linkPortal/slugActions": typeof linkPortal_slugActions;
  "meetings/maintenance": typeof meetings_maintenance;
  migrations: typeof migrations;
  "onboarding/complete": typeof onboarding_complete;
  "onboarding/invite": typeof onboarding_invite;
  "operations/bookingHealth": typeof operations_bookingHealth;
  "operations/meetingStats": typeof operations_meetingStats;
  "operations/phoneSales": typeof operations_phoneSales;
  "operations/projections": typeof operations_projections;
  "operations/qualifications": typeof operations_qualifications;
  "operations/scheduling": typeof operations_scheduling;
  "operations/unmappedUtms": typeof operations_unmappedUtms;
  "operations/validators": typeof operations_validators;
  "opportunities/createManual": typeof opportunities_createManual;
  "opportunities/detailQuery": typeof opportunities_detailQuery;
  "opportunities/listQueries": typeof opportunities_listQueries;
  "opportunities/maintenance": typeof opportunities_maintenance;
  "opportunities/queries": typeof opportunities_queries;
  "opportunities/staleness": typeof opportunities_staleness;
  "opportunities/validators": typeof opportunities_validators;
  "pipeline/inviteeCanceled": typeof pipeline_inviteeCanceled;
  "pipeline/inviteeCreated": typeof pipeline_inviteeCreated;
  "pipeline/inviteeNoShow": typeof pipeline_inviteeNoShow;
  "pipeline/mutations": typeof pipeline_mutations;
  "pipeline/processor": typeof pipeline_processor;
  "pipeline/queries": typeof pipeline_queries;
  "pipeline/reminderDetail": typeof pipeline_reminderDetail;
  "pipeline/slackJoinLookup": typeof pipeline_slackJoinLookup;
  "reporting/activityFeed": typeof reporting_activityFeed;
  "reporting/aggregates": typeof reporting_aggregates;
  "reporting/backfill": typeof reporting_backfill;
  "reporting/bookedVsSold": typeof reporting_bookedVsSold;
  "reporting/formResponseAnalytics": typeof reporting_formResponseAnalytics;
  "reporting/leadConversion": typeof reporting_leadConversion;
  "reporting/lib/eventLabels": typeof reporting_lib_eventLabels;
  "reporting/lib/helpers": typeof reporting_lib_helpers;
  "reporting/lib/hondurasBusinessTime": typeof reporting_lib_hondurasBusinessTime;
  "reporting/lib/outcomeDerivation": typeof reporting_lib_outcomeDerivation;
  "reporting/lib/periodBucketing": typeof reporting_lib_periodBucketing;
  "reporting/lib/programDimensions": typeof reporting_lib_programDimensions;
  "reporting/lib/slackQualificationBreakdown": typeof reporting_lib_slackQualificationBreakdown;
  "reporting/lib/slackQualificationLedger": typeof reporting_lib_slackQualificationLedger;
  "reporting/pipelineHealth": typeof reporting_pipelineHealth;
  "reporting/remindersReporting": typeof reporting_remindersReporting;
  "reporting/revenue": typeof reporting_revenue;
  "reporting/revenueTrend": typeof reporting_revenueTrend;
  "reporting/slackQualifications": typeof reporting_slackQualifications;
  "reporting/teamActions": typeof reporting_teamActions;
  "reporting/teamOutcomes": typeof reporting_teamOutcomes;
  "reporting/teamPerformance": typeof reporting_teamPerformance;
  "reporting/verification": typeof reporting_verification;
  "reporting/writeHooks": typeof reporting_writeHooks;
  requireSystemAdmin: typeof requireSystemAdmin;
  requireTenantUser: typeof requireTenantUser;
  requireTenantUserFromAction: typeof requireTenantUserFromAction;
  "sideDeals/deleteEmptyOpportunity": typeof sideDeals_deleteEmptyOpportunity;
  "sideDeals/logPayment": typeof sideDeals_logPayment;
  "sideDeals/markLost": typeof sideDeals_markLost;
  "sideDeals/voidPayment": typeof sideDeals_voidPayment;
  "slack/channels": typeof slack_channels;
  "slack/channelsActions": typeof slack_channelsActions;
  "slack/cleanup": typeof slack_cleanup;
  "slack/commands": typeof slack_commands;
  "slack/createQualifiedLead": typeof slack_createQualifiedLead;
  "slack/deepLinks": typeof slack_deepLinks;
  "slack/events": typeof slack_events;
  "slack/inboundStubs": typeof slack_inboundStubs;
  "slack/installations": typeof slack_installations;
  "slack/interactivity": typeof slack_interactivity;
  "slack/metrics": typeof slack_metrics;
  "slack/notify": typeof slack_notify;
  "slack/notifyData": typeof slack_notifyData;
  "slack/oauth": typeof slack_oauth;
  "slack/oauthStateMutations": typeof slack_oauthStateMutations;
  "slack/profileNames": typeof slack_profileNames;
  "slack/rawEvents": typeof slack_rawEvents;
  "slack/rawEventsAudit": typeof slack_rawEventsAudit;
  "slack/refreshCron": typeof slack_refreshCron;
  "slack/staleReminders": typeof slack_staleReminders;
  "slack/staleRemindersData": typeof slack_staleRemindersData;
  "slack/tokens": typeof slack_tokens;
  "slack/userActions": typeof slack_userActions;
  "slack/users": typeof slack_users;
  "slack/webApi": typeof slack_webApi;
  support: typeof support;
  "tenantPrograms/mutations": typeof tenantPrograms_mutations;
  "tenantPrograms/queries": typeof tenantPrograms_queries;
  "tenantPrograms/seed": typeof tenantPrograms_seed;
  "tenantPrograms/shared": typeof tenantPrograms_shared;
  "tenantPrograms/sync": typeof tenantPrograms_sync;
  tenants: typeof tenants;
  "testing/calendly": typeof testing_calendly;
  "testing/e2e": typeof testing_e2e;
  "testing/operationalData": typeof testing_operationalData;
  "unavailability/mutations": typeof unavailability_mutations;
  "unavailability/queries": typeof unavailability_queries;
  "unavailability/redistribution": typeof unavailability_redistribution;
  "unavailability/shared": typeof unavailability_shared;
  "users/assignPersonalEventType": typeof users_assignPersonalEventType;
  "users/linkCalendlyMember": typeof users_linkCalendlyMember;
  "users/queries": typeof users_queries;
  "webhooks/calendly": typeof webhooks_calendly;
  "webhooks/calendlyMutations": typeof webhooks_calendlyMutations;
  "webhooks/calendlyQueries": typeof webhooks_calendlyQueries;
  "webhooks/cleanup": typeof webhooks_cleanup;
  "webhooks/cleanupMutations": typeof webhooks_cleanupMutations;
  "workos/roles": typeof workos_roles;
  "workos/userActions": typeof workos_userActions;
  "workos/userManagement": typeof workos_userManagement;
  "workos/userMutations": typeof workos_userMutations;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workOSAuthKit: {
    lib: {
      enqueueWebhookEvent: FunctionReference<
        "mutation",
        "internal",
        {
          apiKey: string;
          event: string;
          eventId: string;
          eventTypes?: Array<string>;
          logLevel?: "DEBUG";
          onEventHandle?: string;
          updatedAt?: string;
        },
        any
      >;
      getAuthUser: FunctionReference<
        "query",
        "internal",
        { id: string },
        {
          createdAt: string;
          email: string;
          emailVerified: boolean;
          externalId?: null | string;
          firstName?: null | string;
          id: string;
          lastName?: null | string;
          lastSignInAt?: null | string;
          locale?: null | string;
          metadata: Record<string, any>;
          profilePictureUrl?: null | string;
          updatedAt: string;
        } | null
      >;
    };
  };
  migrations: {
    lib: {
      cancel: FunctionReference<
        "mutation",
        "internal",
        { name: string },
        {
          batchSize?: number;
          cursor?: string | null;
          error?: string;
          isDone: boolean;
          latestEnd?: number;
          latestStart: number;
          name: string;
          next?: Array<string>;
          processed: number;
          state: "inProgress" | "success" | "failed" | "canceled" | "unknown";
        }
      >;
      cancelAll: FunctionReference<
        "mutation",
        "internal",
        { sinceTs?: number },
        Array<{
          batchSize?: number;
          cursor?: string | null;
          error?: string;
          isDone: boolean;
          latestEnd?: number;
          latestStart: number;
          name: string;
          next?: Array<string>;
          processed: number;
          state: "inProgress" | "success" | "failed" | "canceled" | "unknown";
        }>
      >;
      clearAll: FunctionReference<
        "mutation",
        "internal",
        { before?: number },
        null
      >;
      getStatus: FunctionReference<
        "query",
        "internal",
        { limit?: number; names?: Array<string> },
        Array<{
          batchSize?: number;
          cursor?: string | null;
          error?: string;
          isDone: boolean;
          latestEnd?: number;
          latestStart: number;
          name: string;
          next?: Array<string>;
          processed: number;
          state: "inProgress" | "success" | "failed" | "canceled" | "unknown";
        }>
      >;
      migrate: FunctionReference<
        "mutation",
        "internal",
        {
          batchSize?: number;
          cursor?: string | null;
          dryRun: boolean;
          fnHandle: string;
          name: string;
          next?: Array<{ fnHandle: string; name: string }>;
          oneBatchOnly?: boolean;
          reset?: boolean;
        },
        {
          batchSize?: number;
          cursor?: string | null;
          error?: string;
          isDone: boolean;
          latestEnd?: number;
          latestStart: number;
          name: string;
          next?: Array<string>;
          processed: number;
          state: "inProgress" | "success" | "failed" | "canceled" | "unknown";
        }
      >;
    };
  };
  meetingsByStatus: {
    btree: {
      aggregateBetween: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any },
        { count: number; sum: number }
      >;
      aggregateBetweenBatch: FunctionReference<
        "query",
        "internal",
        { queries: Array<{ k1?: any; k2?: any; namespace?: any }> },
        Array<{ count: number; sum: number }>
      >;
      atNegativeOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffsetBatch: FunctionReference<
        "query",
        "internal",
        {
          queries: Array<{
            k1?: any;
            k2?: any;
            namespace?: any;
            offset: number;
          }>;
        },
        Array<{ k: any; s: number; v: any }>
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: any; namespace?: any },
        null | { k: any; s: number; v: any }
      >;
      offset: FunctionReference<
        "query",
        "internal",
        { k1?: any; key: any; namespace?: any },
        number
      >;
      offsetUntil: FunctionReference<
        "query",
        "internal",
        { k2?: any; key: any; namespace?: any },
        number
      >;
      paginate: FunctionReference<
        "query",
        "internal",
        {
          cursor?: string;
          k1?: any;
          k2?: any;
          limit: number;
          namespace?: any;
          order: "asc" | "desc";
        },
        {
          cursor: string;
          isDone: boolean;
          page: Array<{ k: any; s: number; v: any }>;
        }
      >;
      paginateNamespaces: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit: number },
        { cursor: string; isDone: boolean; page: Array<any> }
      >;
      validate: FunctionReference<
        "query",
        "internal",
        { namespace?: any },
        any
      >;
    };
    inspect: {
      display: FunctionReference<"query", "internal", { namespace?: any }, any>;
      dump: FunctionReference<"query", "internal", { namespace?: any }, string>;
      inspectNode: FunctionReference<
        "query",
        "internal",
        { namespace?: any; node?: string },
        null
      >;
      listTreeNodes: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          aggregate?: { count: number; sum: number };
          items: Array<{ k: any; s: number; v: any }>;
          subtrees: Array<string>;
        }>
      >;
      listTrees: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          maxNodeSize: number;
          namespace?: any;
          root: string;
        }>
      >;
    };
    public: {
      clear: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      delete_: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        null
      >;
      deleteIfExists: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        any
      >;
      init: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      insert: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any; summand?: number; value: any },
        null
      >;
      makeRootLazy: FunctionReference<
        "mutation",
        "internal",
        { namespace?: any },
        null
      >;
      replace: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        null
      >;
      replaceOrInsert: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        any
      >;
    };
  };
  paymentSums: {
    btree: {
      aggregateBetween: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any },
        { count: number; sum: number }
      >;
      aggregateBetweenBatch: FunctionReference<
        "query",
        "internal",
        { queries: Array<{ k1?: any; k2?: any; namespace?: any }> },
        Array<{ count: number; sum: number }>
      >;
      atNegativeOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffsetBatch: FunctionReference<
        "query",
        "internal",
        {
          queries: Array<{
            k1?: any;
            k2?: any;
            namespace?: any;
            offset: number;
          }>;
        },
        Array<{ k: any; s: number; v: any }>
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: any; namespace?: any },
        null | { k: any; s: number; v: any }
      >;
      offset: FunctionReference<
        "query",
        "internal",
        { k1?: any; key: any; namespace?: any },
        number
      >;
      offsetUntil: FunctionReference<
        "query",
        "internal",
        { k2?: any; key: any; namespace?: any },
        number
      >;
      paginate: FunctionReference<
        "query",
        "internal",
        {
          cursor?: string;
          k1?: any;
          k2?: any;
          limit: number;
          namespace?: any;
          order: "asc" | "desc";
        },
        {
          cursor: string;
          isDone: boolean;
          page: Array<{ k: any; s: number; v: any }>;
        }
      >;
      paginateNamespaces: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit: number },
        { cursor: string; isDone: boolean; page: Array<any> }
      >;
      validate: FunctionReference<
        "query",
        "internal",
        { namespace?: any },
        any
      >;
    };
    inspect: {
      display: FunctionReference<"query", "internal", { namespace?: any }, any>;
      dump: FunctionReference<"query", "internal", { namespace?: any }, string>;
      inspectNode: FunctionReference<
        "query",
        "internal",
        { namespace?: any; node?: string },
        null
      >;
      listTreeNodes: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          aggregate?: { count: number; sum: number };
          items: Array<{ k: any; s: number; v: any }>;
          subtrees: Array<string>;
        }>
      >;
      listTrees: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          maxNodeSize: number;
          namespace?: any;
          root: string;
        }>
      >;
    };
    public: {
      clear: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      delete_: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        null
      >;
      deleteIfExists: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        any
      >;
      init: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      insert: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any; summand?: number; value: any },
        null
      >;
      makeRootLazy: FunctionReference<
        "mutation",
        "internal",
        { namespace?: any },
        null
      >;
      replace: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        null
      >;
      replaceOrInsert: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        any
      >;
    };
  };
  opportunityByStatus: {
    btree: {
      aggregateBetween: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any },
        { count: number; sum: number }
      >;
      aggregateBetweenBatch: FunctionReference<
        "query",
        "internal",
        { queries: Array<{ k1?: any; k2?: any; namespace?: any }> },
        Array<{ count: number; sum: number }>
      >;
      atNegativeOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffsetBatch: FunctionReference<
        "query",
        "internal",
        {
          queries: Array<{
            k1?: any;
            k2?: any;
            namespace?: any;
            offset: number;
          }>;
        },
        Array<{ k: any; s: number; v: any }>
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: any; namespace?: any },
        null | { k: any; s: number; v: any }
      >;
      offset: FunctionReference<
        "query",
        "internal",
        { k1?: any; key: any; namespace?: any },
        number
      >;
      offsetUntil: FunctionReference<
        "query",
        "internal",
        { k2?: any; key: any; namespace?: any },
        number
      >;
      paginate: FunctionReference<
        "query",
        "internal",
        {
          cursor?: string;
          k1?: any;
          k2?: any;
          limit: number;
          namespace?: any;
          order: "asc" | "desc";
        },
        {
          cursor: string;
          isDone: boolean;
          page: Array<{ k: any; s: number; v: any }>;
        }
      >;
      paginateNamespaces: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit: number },
        { cursor: string; isDone: boolean; page: Array<any> }
      >;
      validate: FunctionReference<
        "query",
        "internal",
        { namespace?: any },
        any
      >;
    };
    inspect: {
      display: FunctionReference<"query", "internal", { namespace?: any }, any>;
      dump: FunctionReference<"query", "internal", { namespace?: any }, string>;
      inspectNode: FunctionReference<
        "query",
        "internal",
        { namespace?: any; node?: string },
        null
      >;
      listTreeNodes: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          aggregate?: { count: number; sum: number };
          items: Array<{ k: any; s: number; v: any }>;
          subtrees: Array<string>;
        }>
      >;
      listTrees: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          maxNodeSize: number;
          namespace?: any;
          root: string;
        }>
      >;
    };
    public: {
      clear: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      delete_: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        null
      >;
      deleteIfExists: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        any
      >;
      init: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      insert: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any; summand?: number; value: any },
        null
      >;
      makeRootLazy: FunctionReference<
        "mutation",
        "internal",
        { namespace?: any },
        null
      >;
      replace: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        null
      >;
      replaceOrInsert: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        any
      >;
    };
  };
  leadTimeline: {
    btree: {
      aggregateBetween: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any },
        { count: number; sum: number }
      >;
      aggregateBetweenBatch: FunctionReference<
        "query",
        "internal",
        { queries: Array<{ k1?: any; k2?: any; namespace?: any }> },
        Array<{ count: number; sum: number }>
      >;
      atNegativeOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffsetBatch: FunctionReference<
        "query",
        "internal",
        {
          queries: Array<{
            k1?: any;
            k2?: any;
            namespace?: any;
            offset: number;
          }>;
        },
        Array<{ k: any; s: number; v: any }>
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: any; namespace?: any },
        null | { k: any; s: number; v: any }
      >;
      offset: FunctionReference<
        "query",
        "internal",
        { k1?: any; key: any; namespace?: any },
        number
      >;
      offsetUntil: FunctionReference<
        "query",
        "internal",
        { k2?: any; key: any; namespace?: any },
        number
      >;
      paginate: FunctionReference<
        "query",
        "internal",
        {
          cursor?: string;
          k1?: any;
          k2?: any;
          limit: number;
          namespace?: any;
          order: "asc" | "desc";
        },
        {
          cursor: string;
          isDone: boolean;
          page: Array<{ k: any; s: number; v: any }>;
        }
      >;
      paginateNamespaces: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit: number },
        { cursor: string; isDone: boolean; page: Array<any> }
      >;
      validate: FunctionReference<
        "query",
        "internal",
        { namespace?: any },
        any
      >;
    };
    inspect: {
      display: FunctionReference<"query", "internal", { namespace?: any }, any>;
      dump: FunctionReference<"query", "internal", { namespace?: any }, string>;
      inspectNode: FunctionReference<
        "query",
        "internal",
        { namespace?: any; node?: string },
        null
      >;
      listTreeNodes: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          aggregate?: { count: number; sum: number };
          items: Array<{ k: any; s: number; v: any }>;
          subtrees: Array<string>;
        }>
      >;
      listTrees: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          maxNodeSize: number;
          namespace?: any;
          root: string;
        }>
      >;
    };
    public: {
      clear: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      delete_: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        null
      >;
      deleteIfExists: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        any
      >;
      init: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      insert: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any; summand?: number; value: any },
        null
      >;
      makeRootLazy: FunctionReference<
        "mutation",
        "internal",
        { namespace?: any },
        null
      >;
      replace: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        null
      >;
      replaceOrInsert: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        any
      >;
    };
  };
  customerConversions: {
    btree: {
      aggregateBetween: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any },
        { count: number; sum: number }
      >;
      aggregateBetweenBatch: FunctionReference<
        "query",
        "internal",
        { queries: Array<{ k1?: any; k2?: any; namespace?: any }> },
        Array<{ count: number; sum: number }>
      >;
      atNegativeOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffsetBatch: FunctionReference<
        "query",
        "internal",
        {
          queries: Array<{
            k1?: any;
            k2?: any;
            namespace?: any;
            offset: number;
          }>;
        },
        Array<{ k: any; s: number; v: any }>
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: any; namespace?: any },
        null | { k: any; s: number; v: any }
      >;
      offset: FunctionReference<
        "query",
        "internal",
        { k1?: any; key: any; namespace?: any },
        number
      >;
      offsetUntil: FunctionReference<
        "query",
        "internal",
        { k2?: any; key: any; namespace?: any },
        number
      >;
      paginate: FunctionReference<
        "query",
        "internal",
        {
          cursor?: string;
          k1?: any;
          k2?: any;
          limit: number;
          namespace?: any;
          order: "asc" | "desc";
        },
        {
          cursor: string;
          isDone: boolean;
          page: Array<{ k: any; s: number; v: any }>;
        }
      >;
      paginateNamespaces: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit: number },
        { cursor: string; isDone: boolean; page: Array<any> }
      >;
      validate: FunctionReference<
        "query",
        "internal",
        { namespace?: any },
        any
      >;
    };
    inspect: {
      display: FunctionReference<"query", "internal", { namespace?: any }, any>;
      dump: FunctionReference<"query", "internal", { namespace?: any }, string>;
      inspectNode: FunctionReference<
        "query",
        "internal",
        { namespace?: any; node?: string },
        null
      >;
      listTreeNodes: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          aggregate?: { count: number; sum: number };
          items: Array<{ k: any; s: number; v: any }>;
          subtrees: Array<string>;
        }>
      >;
      listTrees: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          maxNodeSize: number;
          namespace?: any;
          root: string;
        }>
      >;
    };
    public: {
      clear: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      delete_: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        null
      >;
      deleteIfExists: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        any
      >;
      init: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      insert: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any; summand?: number; value: any },
        null
      >;
      makeRootLazy: FunctionReference<
        "mutation",
        "internal",
        { namespace?: any },
        null
      >;
      replace: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        null
      >;
      replaceOrInsert: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        any
      >;
    };
  };
  slackQualificationsByUser: {
    btree: {
      aggregateBetween: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any },
        { count: number; sum: number }
      >;
      aggregateBetweenBatch: FunctionReference<
        "query",
        "internal",
        { queries: Array<{ k1?: any; k2?: any; namespace?: any }> },
        Array<{ count: number; sum: number }>
      >;
      atNegativeOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffsetBatch: FunctionReference<
        "query",
        "internal",
        {
          queries: Array<{
            k1?: any;
            k2?: any;
            namespace?: any;
            offset: number;
          }>;
        },
        Array<{ k: any; s: number; v: any }>
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: any; namespace?: any },
        null | { k: any; s: number; v: any }
      >;
      offset: FunctionReference<
        "query",
        "internal",
        { k1?: any; key: any; namespace?: any },
        number
      >;
      offsetUntil: FunctionReference<
        "query",
        "internal",
        { k2?: any; key: any; namespace?: any },
        number
      >;
      paginate: FunctionReference<
        "query",
        "internal",
        {
          cursor?: string;
          k1?: any;
          k2?: any;
          limit: number;
          namespace?: any;
          order: "asc" | "desc";
        },
        {
          cursor: string;
          isDone: boolean;
          page: Array<{ k: any; s: number; v: any }>;
        }
      >;
      paginateNamespaces: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit: number },
        { cursor: string; isDone: boolean; page: Array<any> }
      >;
      validate: FunctionReference<
        "query",
        "internal",
        { namespace?: any },
        any
      >;
    };
    inspect: {
      display: FunctionReference<"query", "internal", { namespace?: any }, any>;
      dump: FunctionReference<"query", "internal", { namespace?: any }, string>;
      inspectNode: FunctionReference<
        "query",
        "internal",
        { namespace?: any; node?: string },
        null
      >;
      listTreeNodes: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          aggregate?: { count: number; sum: number };
          items: Array<{ k: any; s: number; v: any }>;
          subtrees: Array<string>;
        }>
      >;
      listTrees: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          maxNodeSize: number;
          namespace?: any;
          root: string;
        }>
      >;
    };
    public: {
      clear: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      delete_: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        null
      >;
      deleteIfExists: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        any
      >;
      init: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      insert: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any; summand?: number; value: any },
        null
      >;
      makeRootLazy: FunctionReference<
        "mutation",
        "internal",
        { namespace?: any },
        null
      >;
      replace: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        null
      >;
      replaceOrInsert: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        any
      >;
    };
  };
  slackQualificationsByTime: {
    btree: {
      aggregateBetween: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any },
        { count: number; sum: number }
      >;
      aggregateBetweenBatch: FunctionReference<
        "query",
        "internal",
        { queries: Array<{ k1?: any; k2?: any; namespace?: any }> },
        Array<{ count: number; sum: number }>
      >;
      atNegativeOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffsetBatch: FunctionReference<
        "query",
        "internal",
        {
          queries: Array<{
            k1?: any;
            k2?: any;
            namespace?: any;
            offset: number;
          }>;
        },
        Array<{ k: any; s: number; v: any }>
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: any; namespace?: any },
        null | { k: any; s: number; v: any }
      >;
      offset: FunctionReference<
        "query",
        "internal",
        { k1?: any; key: any; namespace?: any },
        number
      >;
      offsetUntil: FunctionReference<
        "query",
        "internal",
        { k2?: any; key: any; namespace?: any },
        number
      >;
      paginate: FunctionReference<
        "query",
        "internal",
        {
          cursor?: string;
          k1?: any;
          k2?: any;
          limit: number;
          namespace?: any;
          order: "asc" | "desc";
        },
        {
          cursor: string;
          isDone: boolean;
          page: Array<{ k: any; s: number; v: any }>;
        }
      >;
      paginateNamespaces: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit: number },
        { cursor: string; isDone: boolean; page: Array<any> }
      >;
      validate: FunctionReference<
        "query",
        "internal",
        { namespace?: any },
        any
      >;
    };
    inspect: {
      display: FunctionReference<"query", "internal", { namespace?: any }, any>;
      dump: FunctionReference<"query", "internal", { namespace?: any }, string>;
      inspectNode: FunctionReference<
        "query",
        "internal",
        { namespace?: any; node?: string },
        null
      >;
      listTreeNodes: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          aggregate?: { count: number; sum: number };
          items: Array<{ k: any; s: number; v: any }>;
          subtrees: Array<string>;
        }>
      >;
      listTrees: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          maxNodeSize: number;
          namespace?: any;
          root: string;
        }>
      >;
    };
    public: {
      clear: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      delete_: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        null
      >;
      deleteIfExists: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        any
      >;
      init: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      insert: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any; summand?: number; value: any },
        null
      >;
      makeRootLazy: FunctionReference<
        "mutation",
        "internal",
        { namespace?: any },
        null
      >;
      replace: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        null
      >;
      replaceOrInsert: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        any
      >;
    };
  };
  billingPaymentsByStatus: {
    btree: {
      aggregateBetween: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any },
        { count: number; sum: number }
      >;
      aggregateBetweenBatch: FunctionReference<
        "query",
        "internal",
        { queries: Array<{ k1?: any; k2?: any; namespace?: any }> },
        Array<{ count: number; sum: number }>
      >;
      atNegativeOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffsetBatch: FunctionReference<
        "query",
        "internal",
        {
          queries: Array<{
            k1?: any;
            k2?: any;
            namespace?: any;
            offset: number;
          }>;
        },
        Array<{ k: any; s: number; v: any }>
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: any; namespace?: any },
        null | { k: any; s: number; v: any }
      >;
      offset: FunctionReference<
        "query",
        "internal",
        { k1?: any; key: any; namespace?: any },
        number
      >;
      offsetUntil: FunctionReference<
        "query",
        "internal",
        { k2?: any; key: any; namespace?: any },
        number
      >;
      paginate: FunctionReference<
        "query",
        "internal",
        {
          cursor?: string;
          k1?: any;
          k2?: any;
          limit: number;
          namespace?: any;
          order: "asc" | "desc";
        },
        {
          cursor: string;
          isDone: boolean;
          page: Array<{ k: any; s: number; v: any }>;
        }
      >;
      paginateNamespaces: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit: number },
        { cursor: string; isDone: boolean; page: Array<any> }
      >;
      validate: FunctionReference<
        "query",
        "internal",
        { namespace?: any },
        any
      >;
    };
    inspect: {
      display: FunctionReference<"query", "internal", { namespace?: any }, any>;
      dump: FunctionReference<"query", "internal", { namespace?: any }, string>;
      inspectNode: FunctionReference<
        "query",
        "internal",
        { namespace?: any; node?: string },
        null
      >;
      listTreeNodes: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          aggregate?: { count: number; sum: number };
          items: Array<{ k: any; s: number; v: any }>;
          subtrees: Array<string>;
        }>
      >;
      listTrees: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          maxNodeSize: number;
          namespace?: any;
          root: string;
        }>
      >;
    };
    public: {
      clear: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      delete_: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        null
      >;
      deleteIfExists: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        any
      >;
      init: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      insert: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any; summand?: number; value: any },
        null
      >;
      makeRootLazy: FunctionReference<
        "mutation",
        "internal",
        { namespace?: any },
        null
      >;
      replace: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        null
      >;
      replaceOrInsert: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        any
      >;
    };
  };
  billingPaymentsByStatusProgram: {
    btree: {
      aggregateBetween: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any },
        { count: number; sum: number }
      >;
      aggregateBetweenBatch: FunctionReference<
        "query",
        "internal",
        { queries: Array<{ k1?: any; k2?: any; namespace?: any }> },
        Array<{ count: number; sum: number }>
      >;
      atNegativeOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffsetBatch: FunctionReference<
        "query",
        "internal",
        {
          queries: Array<{
            k1?: any;
            k2?: any;
            namespace?: any;
            offset: number;
          }>;
        },
        Array<{ k: any; s: number; v: any }>
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: any; namespace?: any },
        null | { k: any; s: number; v: any }
      >;
      offset: FunctionReference<
        "query",
        "internal",
        { k1?: any; key: any; namespace?: any },
        number
      >;
      offsetUntil: FunctionReference<
        "query",
        "internal",
        { k2?: any; key: any; namespace?: any },
        number
      >;
      paginate: FunctionReference<
        "query",
        "internal",
        {
          cursor?: string;
          k1?: any;
          k2?: any;
          limit: number;
          namespace?: any;
          order: "asc" | "desc";
        },
        {
          cursor: string;
          isDone: boolean;
          page: Array<{ k: any; s: number; v: any }>;
        }
      >;
      paginateNamespaces: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit: number },
        { cursor: string; isDone: boolean; page: Array<any> }
      >;
      validate: FunctionReference<
        "query",
        "internal",
        { namespace?: any },
        any
      >;
    };
    inspect: {
      display: FunctionReference<"query", "internal", { namespace?: any }, any>;
      dump: FunctionReference<"query", "internal", { namespace?: any }, string>;
      inspectNode: FunctionReference<
        "query",
        "internal",
        { namespace?: any; node?: string },
        null
      >;
      listTreeNodes: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          aggregate?: { count: number; sum: number };
          items: Array<{ k: any; s: number; v: any }>;
          subtrees: Array<string>;
        }>
      >;
      listTrees: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          maxNodeSize: number;
          namespace?: any;
          root: string;
        }>
      >;
    };
    public: {
      clear: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      delete_: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        null
      >;
      deleteIfExists: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        any
      >;
      init: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      insert: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any; summand?: number; value: any },
        null
      >;
      makeRootLazy: FunctionReference<
        "mutation",
        "internal",
        { namespace?: any },
        null
      >;
      replace: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        null
      >;
      replaceOrInsert: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        any
      >;
    };
  };
  billingPaymentsByStatusType: {
    btree: {
      aggregateBetween: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any },
        { count: number; sum: number }
      >;
      aggregateBetweenBatch: FunctionReference<
        "query",
        "internal",
        { queries: Array<{ k1?: any; k2?: any; namespace?: any }> },
        Array<{ count: number; sum: number }>
      >;
      atNegativeOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffsetBatch: FunctionReference<
        "query",
        "internal",
        {
          queries: Array<{
            k1?: any;
            k2?: any;
            namespace?: any;
            offset: number;
          }>;
        },
        Array<{ k: any; s: number; v: any }>
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: any; namespace?: any },
        null | { k: any; s: number; v: any }
      >;
      offset: FunctionReference<
        "query",
        "internal",
        { k1?: any; key: any; namespace?: any },
        number
      >;
      offsetUntil: FunctionReference<
        "query",
        "internal",
        { k2?: any; key: any; namespace?: any },
        number
      >;
      paginate: FunctionReference<
        "query",
        "internal",
        {
          cursor?: string;
          k1?: any;
          k2?: any;
          limit: number;
          namespace?: any;
          order: "asc" | "desc";
        },
        {
          cursor: string;
          isDone: boolean;
          page: Array<{ k: any; s: number; v: any }>;
        }
      >;
      paginateNamespaces: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit: number },
        { cursor: string; isDone: boolean; page: Array<any> }
      >;
      validate: FunctionReference<
        "query",
        "internal",
        { namespace?: any },
        any
      >;
    };
    inspect: {
      display: FunctionReference<"query", "internal", { namespace?: any }, any>;
      dump: FunctionReference<"query", "internal", { namespace?: any }, string>;
      inspectNode: FunctionReference<
        "query",
        "internal",
        { namespace?: any; node?: string },
        null
      >;
      listTreeNodes: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          aggregate?: { count: number; sum: number };
          items: Array<{ k: any; s: number; v: any }>;
          subtrees: Array<string>;
        }>
      >;
      listTrees: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          maxNodeSize: number;
          namespace?: any;
          root: string;
        }>
      >;
    };
    public: {
      clear: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      delete_: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        null
      >;
      deleteIfExists: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        any
      >;
      init: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      insert: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any; summand?: number; value: any },
        null
      >;
      makeRootLazy: FunctionReference<
        "mutation",
        "internal",
        { namespace?: any },
        null
      >;
      replace: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        null
      >;
      replaceOrInsert: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        any
      >;
    };
  };
  billingPaymentsByStatusProgramType: {
    btree: {
      aggregateBetween: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any },
        { count: number; sum: number }
      >;
      aggregateBetweenBatch: FunctionReference<
        "query",
        "internal",
        { queries: Array<{ k1?: any; k2?: any; namespace?: any }> },
        Array<{ count: number; sum: number }>
      >;
      atNegativeOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffset: FunctionReference<
        "query",
        "internal",
        { k1?: any; k2?: any; namespace?: any; offset: number },
        { k: any; s: number; v: any }
      >;
      atOffsetBatch: FunctionReference<
        "query",
        "internal",
        {
          queries: Array<{
            k1?: any;
            k2?: any;
            namespace?: any;
            offset: number;
          }>;
        },
        Array<{ k: any; s: number; v: any }>
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: any; namespace?: any },
        null | { k: any; s: number; v: any }
      >;
      offset: FunctionReference<
        "query",
        "internal",
        { k1?: any; key: any; namespace?: any },
        number
      >;
      offsetUntil: FunctionReference<
        "query",
        "internal",
        { k2?: any; key: any; namespace?: any },
        number
      >;
      paginate: FunctionReference<
        "query",
        "internal",
        {
          cursor?: string;
          k1?: any;
          k2?: any;
          limit: number;
          namespace?: any;
          order: "asc" | "desc";
        },
        {
          cursor: string;
          isDone: boolean;
          page: Array<{ k: any; s: number; v: any }>;
        }
      >;
      paginateNamespaces: FunctionReference<
        "query",
        "internal",
        { cursor?: string; limit: number },
        { cursor: string; isDone: boolean; page: Array<any> }
      >;
      validate: FunctionReference<
        "query",
        "internal",
        { namespace?: any },
        any
      >;
    };
    inspect: {
      display: FunctionReference<"query", "internal", { namespace?: any }, any>;
      dump: FunctionReference<"query", "internal", { namespace?: any }, string>;
      inspectNode: FunctionReference<
        "query",
        "internal",
        { namespace?: any; node?: string },
        null
      >;
      listTreeNodes: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          aggregate?: { count: number; sum: number };
          items: Array<{ k: any; s: number; v: any }>;
          subtrees: Array<string>;
        }>
      >;
      listTrees: FunctionReference<
        "query",
        "internal",
        { take?: number },
        Array<{
          _creationTime: number;
          _id: string;
          maxNodeSize: number;
          namespace?: any;
          root: string;
        }>
      >;
    };
    public: {
      clear: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      delete_: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        null
      >;
      deleteIfExists: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any },
        any
      >;
      init: FunctionReference<
        "mutation",
        "internal",
        { maxNodeSize?: number; namespace?: any; rootLazy?: boolean },
        null
      >;
      insert: FunctionReference<
        "mutation",
        "internal",
        { key: any; namespace?: any; summand?: number; value: any },
        null
      >;
      makeRootLazy: FunctionReference<
        "mutation",
        "internal",
        { namespace?: any },
        null
      >;
      replace: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        null
      >;
      replaceOrInsert: FunctionReference<
        "mutation",
        "internal",
        {
          currentKey: any;
          namespace?: any;
          newKey: any;
          newNamespace?: any;
          summand?: number;
          value: any;
        },
        any
      >;
    };
  };
};
