/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin_inviteCleanup from "../admin/inviteCleanup.js";
import type * as admin_inviteCleanupMutations from "../admin/inviteCleanupMutations.js";
import type * as admin_meetingActions from "../admin/meetingActions.js";
import type * as admin_migrations from "../admin/migrations.js";
import type * as admin_rawWebhookReplay from "../admin/rawWebhookReplay.js";
import type * as admin_tenants from "../admin/tenants.js";
import type * as admin_tenantsMutations from "../admin/tenantsMutations.js";
import type * as admin_tenantsQueries from "../admin/tenantsQueries.js";
import type * as auth from "../auth.js";
import type * as calendly_connectionQueries from "../calendly/connectionQueries.js";
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
import type * as closer_meetingOverrun from "../closer/meetingOverrun.js";
import type * as closer_meetingOverrunSweep from "../closer/meetingOverrunSweep.js";
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
import type * as eventTypeConfigs_mutations from "../eventTypeConfigs/mutations.js";
import type * as eventTypeConfigs_queries from "../eventTypeConfigs/queries.js";
import type * as http from "../http.js";
import type * as leads_merge from "../leads/merge.js";
import type * as leads_mutations from "../leads/mutations.js";
import type * as leads_queries from "../leads/queries.js";
import type * as leads_searchTextBuilder from "../leads/searchTextBuilder.js";
import type * as lib_activeFollowUp from "../lib/activeFollowUp.js";
import type * as lib_attendanceChecks from "../lib/attendanceChecks.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_domainEvents from "../lib/domainEvents.js";
import type * as lib_formatMoney from "../lib/formatMoney.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_inviteToken from "../lib/inviteToken.js";
import type * as lib_manualMeetingTimes from "../lib/manualMeetingTimes.js";
import type * as lib_meetingFormResponses from "../lib/meetingFormResponses.js";
import type * as lib_meetingLocation from "../lib/meetingLocation.js";
import type * as lib_normalization from "../lib/normalization.js";
import type * as lib_opportunityMeetingRefs from "../lib/opportunityMeetingRefs.js";
import type * as lib_outcomeHelpers from "../lib/outcomeHelpers.js";
import type * as lib_overranReviewGuards from "../lib/overranReviewGuards.js";
import type * as lib_payloadExtraction from "../lib/payloadExtraction.js";
import type * as lib_paymentHelpers from "../lib/paymentHelpers.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_roleMapping from "../lib/roleMapping.js";
import type * as lib_statusTransitions from "../lib/statusTransitions.js";
import type * as lib_syncCustomerSnapshot from "../lib/syncCustomerSnapshot.js";
import type * as lib_syncLeadMeetingNames from "../lib/syncLeadMeetingNames.js";
import type * as lib_syncOpportunityMeetingsAssignedCloser from "../lib/syncOpportunityMeetingsAssignedCloser.js";
import type * as lib_tenantCalendlyConnection from "../lib/tenantCalendlyConnection.js";
import type * as lib_tenantStatsHelper from "../lib/tenantStatsHelper.js";
import type * as lib_unavailabilityValidation from "../lib/unavailabilityValidation.js";
import type * as lib_utmParams from "../lib/utmParams.js";
import type * as lib_validation from "../lib/validation.js";
import type * as lib_workosUserId from "../lib/workosUserId.js";
import type * as meetings_maintenance from "../meetings/maintenance.js";
import type * as onboarding_complete from "../onboarding/complete.js";
import type * as onboarding_invite from "../onboarding/invite.js";
import type * as opportunities_maintenance from "../opportunities/maintenance.js";
import type * as opportunities_queries from "../opportunities/queries.js";
import type * as pipeline_inviteeCanceled from "../pipeline/inviteeCanceled.js";
import type * as pipeline_inviteeCreated from "../pipeline/inviteeCreated.js";
import type * as pipeline_inviteeNoShow from "../pipeline/inviteeNoShow.js";
import type * as pipeline_mutations from "../pipeline/mutations.js";
import type * as pipeline_processor from "../pipeline/processor.js";
import type * as pipeline_queries from "../pipeline/queries.js";
import type * as reporting_activityFeed from "../reporting/activityFeed.js";
import type * as reporting_aggregates from "../reporting/aggregates.js";
import type * as reporting_backfill from "../reporting/backfill.js";
import type * as reporting_formResponseAnalytics from "../reporting/formResponseAnalytics.js";
import type * as reporting_leadConversion from "../reporting/leadConversion.js";
import type * as reporting_lib_eventLabels from "../reporting/lib/eventLabels.js";
import type * as reporting_lib_helpers from "../reporting/lib/helpers.js";
import type * as reporting_lib_outcomeDerivation from "../reporting/lib/outcomeDerivation.js";
import type * as reporting_lib_periodBucketing from "../reporting/lib/periodBucketing.js";
import type * as reporting_meetingTime from "../reporting/meetingTime.js";
import type * as reporting_pipelineHealth from "../reporting/pipelineHealth.js";
import type * as reporting_remindersReporting from "../reporting/remindersReporting.js";
import type * as reporting_revenue from "../reporting/revenue.js";
import type * as reporting_revenueTrend from "../reporting/revenueTrend.js";
import type * as reporting_reviewsReporting from "../reporting/reviewsReporting.js";
import type * as reporting_teamActions from "../reporting/teamActions.js";
import type * as reporting_teamOutcomes from "../reporting/teamOutcomes.js";
import type * as reporting_teamPerformance from "../reporting/teamPerformance.js";
import type * as reporting_verification from "../reporting/verification.js";
import type * as reporting_writeHooks from "../reporting/writeHooks.js";
import type * as requireSystemAdmin from "../requireSystemAdmin.js";
import type * as requireTenantUser from "../requireTenantUser.js";
import type * as reviews_mutations from "../reviews/mutations.js";
import type * as reviews_queries from "../reviews/queries.js";
import type * as tenants from "../tenants.js";
import type * as testing_calendly from "../testing/calendly.js";
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
  "admin/inviteCleanup": typeof admin_inviteCleanup;
  "admin/inviteCleanupMutations": typeof admin_inviteCleanupMutations;
  "admin/meetingActions": typeof admin_meetingActions;
  "admin/migrations": typeof admin_migrations;
  "admin/rawWebhookReplay": typeof admin_rawWebhookReplay;
  "admin/tenants": typeof admin_tenants;
  "admin/tenantsMutations": typeof admin_tenantsMutations;
  "admin/tenantsQueries": typeof admin_tenantsQueries;
  auth: typeof auth;
  "calendly/connectionQueries": typeof calendly_connectionQueries;
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
  "closer/meetingOverrun": typeof closer_meetingOverrun;
  "closer/meetingOverrunSweep": typeof closer_meetingOverrunSweep;
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
  "eventTypeConfigs/mutations": typeof eventTypeConfigs_mutations;
  "eventTypeConfigs/queries": typeof eventTypeConfigs_queries;
  http: typeof http;
  "leads/merge": typeof leads_merge;
  "leads/mutations": typeof leads_mutations;
  "leads/queries": typeof leads_queries;
  "leads/searchTextBuilder": typeof leads_searchTextBuilder;
  "lib/activeFollowUp": typeof lib_activeFollowUp;
  "lib/attendanceChecks": typeof lib_attendanceChecks;
  "lib/constants": typeof lib_constants;
  "lib/domainEvents": typeof lib_domainEvents;
  "lib/formatMoney": typeof lib_formatMoney;
  "lib/identity": typeof lib_identity;
  "lib/inviteToken": typeof lib_inviteToken;
  "lib/manualMeetingTimes": typeof lib_manualMeetingTimes;
  "lib/meetingFormResponses": typeof lib_meetingFormResponses;
  "lib/meetingLocation": typeof lib_meetingLocation;
  "lib/normalization": typeof lib_normalization;
  "lib/opportunityMeetingRefs": typeof lib_opportunityMeetingRefs;
  "lib/outcomeHelpers": typeof lib_outcomeHelpers;
  "lib/overranReviewGuards": typeof lib_overranReviewGuards;
  "lib/payloadExtraction": typeof lib_payloadExtraction;
  "lib/paymentHelpers": typeof lib_paymentHelpers;
  "lib/permissions": typeof lib_permissions;
  "lib/roleMapping": typeof lib_roleMapping;
  "lib/statusTransitions": typeof lib_statusTransitions;
  "lib/syncCustomerSnapshot": typeof lib_syncCustomerSnapshot;
  "lib/syncLeadMeetingNames": typeof lib_syncLeadMeetingNames;
  "lib/syncOpportunityMeetingsAssignedCloser": typeof lib_syncOpportunityMeetingsAssignedCloser;
  "lib/tenantCalendlyConnection": typeof lib_tenantCalendlyConnection;
  "lib/tenantStatsHelper": typeof lib_tenantStatsHelper;
  "lib/unavailabilityValidation": typeof lib_unavailabilityValidation;
  "lib/utmParams": typeof lib_utmParams;
  "lib/validation": typeof lib_validation;
  "lib/workosUserId": typeof lib_workosUserId;
  "meetings/maintenance": typeof meetings_maintenance;
  "onboarding/complete": typeof onboarding_complete;
  "onboarding/invite": typeof onboarding_invite;
  "opportunities/maintenance": typeof opportunities_maintenance;
  "opportunities/queries": typeof opportunities_queries;
  "pipeline/inviteeCanceled": typeof pipeline_inviteeCanceled;
  "pipeline/inviteeCreated": typeof pipeline_inviteeCreated;
  "pipeline/inviteeNoShow": typeof pipeline_inviteeNoShow;
  "pipeline/mutations": typeof pipeline_mutations;
  "pipeline/processor": typeof pipeline_processor;
  "pipeline/queries": typeof pipeline_queries;
  "reporting/activityFeed": typeof reporting_activityFeed;
  "reporting/aggregates": typeof reporting_aggregates;
  "reporting/backfill": typeof reporting_backfill;
  "reporting/formResponseAnalytics": typeof reporting_formResponseAnalytics;
  "reporting/leadConversion": typeof reporting_leadConversion;
  "reporting/lib/eventLabels": typeof reporting_lib_eventLabels;
  "reporting/lib/helpers": typeof reporting_lib_helpers;
  "reporting/lib/outcomeDerivation": typeof reporting_lib_outcomeDerivation;
  "reporting/lib/periodBucketing": typeof reporting_lib_periodBucketing;
  "reporting/meetingTime": typeof reporting_meetingTime;
  "reporting/pipelineHealth": typeof reporting_pipelineHealth;
  "reporting/remindersReporting": typeof reporting_remindersReporting;
  "reporting/revenue": typeof reporting_revenue;
  "reporting/revenueTrend": typeof reporting_revenueTrend;
  "reporting/reviewsReporting": typeof reporting_reviewsReporting;
  "reporting/teamActions": typeof reporting_teamActions;
  "reporting/teamOutcomes": typeof reporting_teamOutcomes;
  "reporting/teamPerformance": typeof reporting_teamPerformance;
  "reporting/verification": typeof reporting_verification;
  "reporting/writeHooks": typeof reporting_writeHooks;
  requireSystemAdmin: typeof requireSystemAdmin;
  requireTenantUser: typeof requireTenantUser;
  "reviews/mutations": typeof reviews_mutations;
  "reviews/queries": typeof reviews_queries;
  tenants: typeof tenants;
  "testing/calendly": typeof testing_calendly;
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
};
