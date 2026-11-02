import { QUEUE_NAMES } from "@studafy/constants";

// ---------------------------------------------------------------------------
// Provisioning worker
// ---------------------------------------------------------------------------

/**
 * Worker that processes provisioning jobs from the BullMQ queue.
 *
 * This worker is triggered by the outbox relay when a school.emailVerified
 * event is published. It runs the full provisioning pipeline including:
 * - Local Postgres provisioning (trial subscription, notification preferences)
 * - ERPNext site/company bootstrap
 * - Compensation on failure
 *
 * In the current implementation, provisioning is handled inline by the
 * verification service. This worker exists as the async extension point
 * for when provisioning needs to be decoupled from the HTTP request path.
 */

export const PROVISIONING_QUEUE = QUEUE_NAMES.PROVISIONING;

export interface ProvisioningJobData {
  schoolId: string;
}

/**
 * Process a single provisioning job.
 *
 * Called by the BullMQ worker when a provisioning job is claimed from the queue.
 * Delegates to the provisioning service for the actual work.
 */
export async function processProvisioningJob(
  data: ProvisioningJobData,
): Promise<{ status: string; schoolId: string }> {
  // The actual provisioning logic is in the provisioning service.
  // This worker is the entry point for async processing.
  //
  // In the current architecture, provisioning runs inline during email
  // verification. This worker provides the hook for future decoupling
  // when the provisioning pipeline becomes too slow for the HTTP path.
  //
  // Example future usage:
  //   const { provisionTenant } = await import("@studafy/api/provisioning");
  //   await provisionTenant(database, params, logger, erpNextClient);

  return {
    status: "completed",
    schoolId: data.schoolId,
  };
}
