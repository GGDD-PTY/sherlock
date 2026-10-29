/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as _admin_overview from "../_admin/overview.js";
import type * as _adminVdr_capability from "../_adminVdr/capability.js";
import type * as _adminVdr_capabilityFormat from "../_adminVdr/capabilityFormat.js";
import type * as _adminVdr_serverProof from "../_adminVdr/serverProof.js";
import type * as _analytics_admin from "../_analytics/admin.js";
import type * as _analytics_series from "../_analytics/series.js";
import type * as _analytics_shared from "../_analytics/shared.js";
import type * as _deliverables_clientWithdrawal from "../_deliverables/clientWithdrawal.js";
import type * as _deliverables_manualDelivery from "../_deliverables/manualDelivery.js";
import type * as _deliverables_model from "../_deliverables/model.js";
import type * as _demoSeed from "../_demoSeed.js";
import type * as _documents_accessIntent from "../_documents/accessIntent.js";
import type * as _documents_accessResult from "../_documents/accessResult.js";
import type * as _documents_activity from "../_documents/activity.js";
import type * as _documents_assetFileInspection from "../_documents/assetFileInspection.js";
import type * as _documents_assetUploadIntents from "../_documents/assetUploadIntents.js";
import type * as _documents_bulk from "../_documents/bulk.js";
import type * as _documents_deliverableVersion from "../_documents/deliverableVersion.js";
import type * as _documents_deliveryProof from "../_documents/deliveryProof.js";
import type * as _documents_fileInspection from "../_documents/fileInspection.js";
import type * as _documents_governance from "../_documents/governance.js";
import type * as _documents_ingest from "../_documents/ingest.js";
import type * as _documents_internals from "../_documents/internals.js";
import type * as _documents_mutations from "../_documents/mutations.js";
import type * as _documents_officeFileInspection from "../_documents/officeFileInspection.js";
import type * as _documents_policy from "../_documents/policy.js";
import type * as _documents_purge from "../_documents/purge.js";
import type * as _documents_queries from "../_documents/queries.js";
import type * as _documents_scanner from "../_documents/scanner.js";
import type * as _documents_shared from "../_documents/shared.js";
import type * as _documents_storage from "../_documents/storage.js";
import type * as _documents_uploadIntents from "../_documents/uploadIntents.js";
import type * as _documents_uploadLimits from "../_documents/uploadLimits.js";
import type * as _documents_versions from "../_documents/versions.js";
import type * as _guests_capabilities from "../_guests/capabilities.js";
import type * as _guests_companyRoom from "../_guests/companyRoom.js";
import type * as _guests_crypto from "../_guests/crypto.js";
import type * as _guests_delivery from "../_guests/delivery.js";
import type * as _guests_documentDelivery from "../_guests/documentDelivery.js";
import type * as _guests_projection from "../_guests/projection.js";
import type * as _guests_serverProof from "../_guests/serverProof.js";
import type * as _guests_serverProofFormat from "../_guests/serverProofFormat.js";
import type * as _guests_service from "../_guests/service.js";
import type * as _guests_sessions from "../_guests/sessions.js";
import type * as _helpers_auditLog from "../_helpers/auditLog.js";
import type * as _helpers_auth from "../_helpers/auth.js";
import type * as _helpers_batch from "../_helpers/batch.js";
import type * as _helpers_companyAuthorization from "../_helpers/companyAuthorization.js";
import type * as _helpers_companyName from "../_helpers/companyName.js";
import type * as _helpers_companyVisibility from "../_helpers/companyVisibility.js";
import type * as _helpers_contactPhone from "../_helpers/contactPhone.js";
import type * as _helpers_effect from "../_helpers/effect.js";
import type * as _helpers_emailConfig from "../_helpers/emailConfig.js";
import type * as _helpers_emailTemplates from "../_helpers/emailTemplates.js";
import type * as _helpers_errors from "../_helpers/errors.js";
import type * as _helpers_focusBand from "../_helpers/focusBand.js";
import type * as _helpers_kycFilter from "../_helpers/kycFilter.js";
import type * as _helpers_limits from "../_helpers/limits.js";
import type * as _helpers_logger from "../_helpers/logger.js";
import type * as _helpers_operatorActor from "../_helpers/operatorActor.js";
import type * as _helpers_rateLimit from "../_helpers/rateLimit.js";
import type * as _helpers_sha256 from "../_helpers/sha256.js";
import type * as _helpers_teamEmailTemplates from "../_helpers/teamEmailTemplates.js";
import type * as _intake_claim from "../_intake/claim.js";
import type * as _intake_claimProof from "../_intake/claimProof.js";
import type * as _intake_crypto from "../_intake/crypto.js";
import type * as _intake_model from "../_intake/model.js";
import type * as _intake_proofFormat from "../_intake/proofFormat.js";
import type * as _intake_serverProof from "../_intake/serverProof.js";
import type * as _intake_sessions from "../_intake/sessions.js";
import type * as _intake_storage from "../_intake/storage.js";
import type * as _localSeed from "../_localSeed.js";
import type * as _notifications_deliverableVisibility from "../_notifications/deliverableVisibility.js";
import type * as _notifications_deliverables from "../_notifications/deliverables.js";
import type * as _notifications_emailEvents from "../_notifications/emailEvents.js";
import type * as _notifications_serverErrorAlertRedaction from "../_notifications/serverErrorAlertRedaction.js";
import type * as _notifications_serverErrorAlerts from "../_notifications/serverErrorAlerts.js";
import type * as _notifications_teamAlerts from "../_notifications/teamAlerts.js";
import type * as _roadmap_model from "../_roadmap/model.js";
import type * as _roadmap_registry from "../_roadmap/registry.js";
import type * as _security_shared from "../_security/shared.js";
import type * as _support_model from "../_support/model.js";
import type * as _support_teamEmail from "../_support/teamEmail.js";
import type * as _vdrRead_binding from "../_vdrRead/binding.js";
import type * as _vdrRead_progress from "../_vdrRead/progress.js";
import type * as _vdrRead_serverProof from "../_vdrRead/serverProof.js";
import type * as _vdrRead_serverProofFormat from "../_vdrRead/serverProofFormat.js";
import type * as _vdrWrite_upload from "../_vdrWrite/upload.js";
import type * as activityLogs from "../activityLogs.js";
import type * as admin from "../admin.js";
import type * as adminAuditLogs from "../adminAuditLogs.js";
import type * as adminOverview from "../adminOverview.js";
import type * as adminVdrCapabilities from "../adminVdrCapabilities.js";
import type * as analytics from "../analytics.js";
import type * as analyticsIncremental from "../analyticsIncremental.js";
import type * as analyticsSeries from "../analyticsSeries.js";
import type * as companies from "../companies.js";
import type * as companyAuthorizationRollout from "../companyAuthorizationRollout.js";
import type * as companyChecklist from "../companyChecklist.js";
import type * as cronHandlers from "../cronHandlers.js";
import type * as crons from "../crons.js";
import type * as deliverables from "../deliverables.js";
import type * as devAuth from "../devAuth.js";
import type * as documents from "../documents.js";
import type * as email from "../email.js";
import type * as financialSnapshots from "../financialSnapshots.js";
import type * as gdpr from "../gdpr.js";
import type * as guestAccess from "../guestAccess.js";
import type * as http from "../http.js";
import type * as intake from "../intake.js";
import type * as notifications from "../notifications.js";
import type * as operatorDeliverables from "../operatorDeliverables.js";
import type * as operatorPrune from "../operatorPrune.js";
import type * as operatorPurge from "../operatorPurge.js";
import type * as operatorRestore from "../operatorRestore.js";
import type * as operatorUsage from "../operatorUsage.js";
import type * as roadmap from "../roadmap.js";
import type * as security from "../security.js";
import type * as support from "../support.js";
import type * as users from "../users.js";
import type * as vdrExport from "../vdrExport.js";
import type * as vdrRead from "../vdrRead.js";
import type * as webhookEvents from "../webhookEvents.js";
import type * as workos from "../workos.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "_admin/overview": typeof _admin_overview;
  "_adminVdr/capability": typeof _adminVdr_capability;
  "_adminVdr/capabilityFormat": typeof _adminVdr_capabilityFormat;
  "_adminVdr/serverProof": typeof _adminVdr_serverProof;
  "_analytics/admin": typeof _analytics_admin;
  "_analytics/series": typeof _analytics_series;
  "_analytics/shared": typeof _analytics_shared;
  "_deliverables/clientWithdrawal": typeof _deliverables_clientWithdrawal;
  "_deliverables/manualDelivery": typeof _deliverables_manualDelivery;
  "_deliverables/model": typeof _deliverables_model;
  _demoSeed: typeof _demoSeed;
  "_documents/accessIntent": typeof _documents_accessIntent;
  "_documents/accessResult": typeof _documents_accessResult;
  "_documents/activity": typeof _documents_activity;
  "_documents/assetFileInspection": typeof _documents_assetFileInspection;
  "_documents/assetUploadIntents": typeof _documents_assetUploadIntents;
  "_documents/bulk": typeof _documents_bulk;
  "_documents/deliverableVersion": typeof _documents_deliverableVersion;
  "_documents/deliveryProof": typeof _documents_deliveryProof;
  "_documents/fileInspection": typeof _documents_fileInspection;
  "_documents/governance": typeof _documents_governance;
  "_documents/ingest": typeof _documents_ingest;
  "_documents/internals": typeof _documents_internals;
  "_documents/mutations": typeof _documents_mutations;
  "_documents/officeFileInspection": typeof _documents_officeFileInspection;
  "_documents/policy": typeof _documents_policy;
  "_documents/purge": typeof _documents_purge;
  "_documents/queries": typeof _documents_queries;
  "_documents/scanner": typeof _documents_scanner;
  "_documents/shared": typeof _documents_shared;
  "_documents/storage": typeof _documents_storage;
  "_documents/uploadIntents": typeof _documents_uploadIntents;
  "_documents/uploadLimits": typeof _documents_uploadLimits;
  "_documents/versions": typeof _documents_versions;
  "_guests/capabilities": typeof _guests_capabilities;
  "_guests/companyRoom": typeof _guests_companyRoom;
  "_guests/crypto": typeof _guests_crypto;
  "_guests/delivery": typeof _guests_delivery;
  "_guests/documentDelivery": typeof _guests_documentDelivery;
  "_guests/projection": typeof _guests_projection;
  "_guests/serverProof": typeof _guests_serverProof;
  "_guests/serverProofFormat": typeof _guests_serverProofFormat;
  "_guests/service": typeof _guests_service;
  "_guests/sessions": typeof _guests_sessions;
  "_helpers/auditLog": typeof _helpers_auditLog;
  "_helpers/auth": typeof _helpers_auth;
  "_helpers/batch": typeof _helpers_batch;
  "_helpers/companyAuthorization": typeof _helpers_companyAuthorization;
  "_helpers/companyName": typeof _helpers_companyName;
  "_helpers/companyVisibility": typeof _helpers_companyVisibility;
  "_helpers/contactPhone": typeof _helpers_contactPhone;
  "_helpers/effect": typeof _helpers_effect;
  "_helpers/emailConfig": typeof _helpers_emailConfig;
  "_helpers/emailTemplates": typeof _helpers_emailTemplates;
  "_helpers/errors": typeof _helpers_errors;
  "_helpers/focusBand": typeof _helpers_focusBand;
  "_helpers/kycFilter": typeof _helpers_kycFilter;
  "_helpers/limits": typeof _helpers_limits;
  "_helpers/logger": typeof _helpers_logger;
  "_helpers/operatorActor": typeof _helpers_operatorActor;
  "_helpers/rateLimit": typeof _helpers_rateLimit;
  "_helpers/sha256": typeof _helpers_sha256;
  "_helpers/teamEmailTemplates": typeof _helpers_teamEmailTemplates;
  "_intake/claim": typeof _intake_claim;
  "_intake/claimProof": typeof _intake_claimProof;
  "_intake/crypto": typeof _intake_crypto;
  "_intake/model": typeof _intake_model;
  "_intake/proofFormat": typeof _intake_proofFormat;
  "_intake/serverProof": typeof _intake_serverProof;
  "_intake/sessions": typeof _intake_sessions;
  "_intake/storage": typeof _intake_storage;
  _localSeed: typeof _localSeed;
  "_notifications/deliverableVisibility": typeof _notifications_deliverableVisibility;
  "_notifications/deliverables": typeof _notifications_deliverables;
  "_notifications/emailEvents": typeof _notifications_emailEvents;
  "_notifications/serverErrorAlertRedaction": typeof _notifications_serverErrorAlertRedaction;
  "_notifications/serverErrorAlerts": typeof _notifications_serverErrorAlerts;
  "_notifications/teamAlerts": typeof _notifications_teamAlerts;
  "_roadmap/model": typeof _roadmap_model;
  "_roadmap/registry": typeof _roadmap_registry;
  "_security/shared": typeof _security_shared;
  "_support/model": typeof _support_model;
  "_support/teamEmail": typeof _support_teamEmail;
  "_vdrRead/binding": typeof _vdrRead_binding;
  "_vdrRead/progress": typeof _vdrRead_progress;
  "_vdrRead/serverProof": typeof _vdrRead_serverProof;
  "_vdrRead/serverProofFormat": typeof _vdrRead_serverProofFormat;
  "_vdrWrite/upload": typeof _vdrWrite_upload;
  activityLogs: typeof activityLogs;
  admin: typeof admin;
  adminAuditLogs: typeof adminAuditLogs;
  adminOverview: typeof adminOverview;
  adminVdrCapabilities: typeof adminVdrCapabilities;
  analytics: typeof analytics;
  analyticsIncremental: typeof analyticsIncremental;
  analyticsSeries: typeof analyticsSeries;
  companies: typeof companies;
  companyAuthorizationRollout: typeof companyAuthorizationRollout;
  companyChecklist: typeof companyChecklist;
  cronHandlers: typeof cronHandlers;
  crons: typeof crons;
  deliverables: typeof deliverables;
  devAuth: typeof devAuth;
  documents: typeof documents;
  email: typeof email;
  financialSnapshots: typeof financialSnapshots;
  gdpr: typeof gdpr;
  guestAccess: typeof guestAccess;
  http: typeof http;
  intake: typeof intake;
  notifications: typeof notifications;
  operatorDeliverables: typeof operatorDeliverables;
  operatorPrune: typeof operatorPrune;
  operatorPurge: typeof operatorPurge;
  operatorRestore: typeof operatorRestore;
  operatorUsage: typeof operatorUsage;
  roadmap: typeof roadmap;
  security: typeof security;
  support: typeof support;
  users: typeof users;
  vdrExport: typeof vdrExport;
  vdrRead: typeof vdrRead;
  webhookEvents: typeof webhookEvents;
  workos: typeof workos;
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
  resend: import("@convex-dev/resend/_generated/component.js").ComponentApi<"resend">;
};
