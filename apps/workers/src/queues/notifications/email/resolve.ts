/**
 * Turn a claimed outbox row into an addressed, rendered email.
 *
 * The payload contracts live in apps/api/src/lib/events/schemas.ts and are enforced when the
 * event is emitted; the workers deliberately re-validate nothing and instead read exactly the
 * fields each template needs, casting to the shapes those schemas guarantee.
 */

import { DOMAIN_EVENTS } from "@studafy/constants";

import {
  renderDigestEmail,
  renderInvitationEmail,
  renderNotificationDigestEmail,
  renderSeatDriftEmail,
  renderSubscriptionDunningEmail,
  renderVerificationEmail,
} from "./templates";

import type { EmailTemplate, RenderedEmail } from "./templates";

export interface ClaimedOutboxRow {
  id: string;
  school_id: string;
  event_name: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ResolvedEmail {
  template: EmailTemplate;
  recipient: string;
  content: RenderedEmail;
}

const INVITATION_ACTION_PATH = "/api/auth/invitations/{token}/activate";
const VERIFICATION_ACTION_PATH = "/api/schools/verify-email/{token}";

interface InvitationPayload {
  email: string;
  token: string;
  expiresAt: string;
}

interface VerificationPayload {
  email: string;
  token: string;
  expiresAt: string;
}

interface DigestPayload {
  email: string;
  digestDate: string;
  items: {
    kind: "attendance_alert" | "fee_overdue";
    studentName: string | null;
    text: string;
    occurredAt: string;
  }[];
}

interface NotificationDigestPayload {
  email: string;
  digestDate: string;
  items: {
    notificationType: string;
    title: string;
    body: string;
    occurredAt: string;
  }[];
}

/**
 * The dunning reminder payload the billing sweep writes (ST-134). The schoolId and subscriptionId it
 * carries are correlation handles for subscribers; this renderer needs only the fields below.
 */
interface SubscriptionDunningPayload {
  email: string;
  planName: string;
  dueDate: string;
  gracePeriodEndsAt: string;
}

/**
 * The seat-drift report payload the billing sweep writes (ST-136). Same convention as the dunning
 * payload below: schoolId/subscriptionId are correlation handles; this renderer needs only the
 * fields the template uses.
 */
interface SeatDriftPayload {
  email: string;
  planName: string;
  activeSeatCount: number;
  billedSeatCount: number;
  direction: "upgrade" | "downgrade";
  proratedAmountMinor: number | null;
  currency: string | null;
  effectivePeriodEnd: string | null;
}

/**
 * Resolve one claimed row to the email to send. `frontendUrl` and `schoolName` come from the
 * caller (the dispatcher resolves the school name once per poll cycle) so this stays pure.
 */
export function resolveEmail(
  row: ClaimedOutboxRow,
  context: { frontendUrl: string; schoolName: string },
): ResolvedEmail {
  switch (row.event_name) {
    case DOMAIN_EVENTS.INVITATION_SENT: {
      const payload = row.payload as unknown as InvitationPayload;
      return {
        template: "invitation",
        recipient: payload.email,
        content: renderInvitationEmail({
          schoolName: context.schoolName,
          actionUrl: `${context.frontendUrl}${INVITATION_ACTION_PATH.replace("{token}", payload.token)}`,
          expiresAt: payload.expiresAt,
        }),
      };
    }
    case DOMAIN_EVENTS.SCHOOL_VERIFICATION_EMAIL_SENT: {
      const payload = row.payload as unknown as VerificationPayload;
      return {
        template: "verification",
        recipient: payload.email,
        content: renderVerificationEmail({
          schoolName: context.schoolName,
          actionUrl: `${context.frontendUrl}${VERIFICATION_ACTION_PATH.replace("{token}", payload.token)}`,
          expiresAt: payload.expiresAt,
        }),
      };
    }
    case DOMAIN_EVENTS.DIGEST_SENT: {
      const payload = row.payload as unknown as DigestPayload;
      return {
        template: "digest",
        recipient: payload.email,
        content: renderDigestEmail({
          schoolName: context.schoolName,
          digestDate: payload.digestDate,
          items: payload.items,
        }),
      };
    }
    case DOMAIN_EVENTS.NOTIFICATION_DIGEST_SENT: {
      const payload = row.payload as unknown as NotificationDigestPayload;
      return {
        // Reuses the "digest" app.email_template label rather than adding a new enum value: the
        // event name on the outbox row (and email_deliveries.outbox_event_id) already distinguish
        // this from the parent digest for anyone auditing deliveries, so a second label would say
        // nothing a join can't already answer.
        template: "digest",
        recipient: payload.email,
        content: renderNotificationDigestEmail({
          schoolName: context.schoolName,
          digestDate: payload.digestDate,
          items: payload.items,
        }),
      };
    }
    case DOMAIN_EVENTS.SUBSCRIPTION_DUNNING_SENT: {
      const payload = row.payload as unknown as SubscriptionDunningPayload;
      return {
        template: "dunning",
        recipient: payload.email,
        content: renderSubscriptionDunningEmail({
          schoolName: context.schoolName,
          planName: payload.planName,
          dueDate: payload.dueDate,
          gracePeriodEndsAt: payload.gracePeriodEndsAt,
        }),
      };
    }
    case DOMAIN_EVENTS.SUBSCRIPTION_SEAT_DRIFT_REPORTED: {
      const payload = row.payload as unknown as SeatDriftPayload;
      return {
        template: "seat-drift",
        recipient: payload.email,
        content: renderSeatDriftEmail({
          schoolName: context.schoolName,
          planName: payload.planName,
          activeSeatCount: payload.activeSeatCount,
          billedSeatCount: payload.billedSeatCount,
          direction: payload.direction,
          proratedAmountMinor: payload.proratedAmountMinor,
          currency: payload.currency,
          effectivePeriodEnd: payload.effectivePeriodEnd,
        }),
      };
    }
    default:
      throw new Error(`no email template for outbox event ${row.event_name}`);
  }
}

/** The outbox event names the dispatcher claims. Everything else is out of the email channel's scope. */
export const EMAIL_EVENT_NAMES: readonly string[] = [
  DOMAIN_EVENTS.INVITATION_SENT,
  DOMAIN_EVENTS.SCHOOL_VERIFICATION_EMAIL_SENT,
  DOMAIN_EVENTS.DIGEST_SENT,
  DOMAIN_EVENTS.NOTIFICATION_DIGEST_SENT,
  DOMAIN_EVENTS.SUBSCRIPTION_DUNNING_SENT,
  DOMAIN_EVENTS.SUBSCRIPTION_SEAT_DRIFT_REPORTED,
];
