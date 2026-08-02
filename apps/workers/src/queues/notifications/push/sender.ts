/**
 * FCM send adapter for the push channel.
 *
 * The delivery worker depends on a narrow `PushSender` interface so tests inject a stub and the
 * process never touches Firebase. `createFcmSender` builds the real adapter, or a loud dry-run
 * substitute when no FIREBASE_SERVICE_ACCOUNT is configured (local development and CI) — the same
 * shape createSesSender in the email channel establishes.
 *
 * ## Why the deep link rides in `data`, not `notification`
 *
 * FCM's `notification` block is what the OS renders; `data` is what the app receives on tap. A
 * notification that "arrives" but navigates nowhere is not the acceptance criterion, so the
 * deep-link route travels in `data` beside the correlation handles. The payload contract is the
 * in-app metadata shape from 000017 (`route`, snake_case entity ids) — the key the web and mobile
 * apps already navigate on.
 *
 * ## Token-level errors are the sender's business, send-level errors are not
 *
 * `sendEachForMulticast` returns one response per token. A token FCM no longer recognises is
 * normal decay — the user uninstalled the app or the installation id rotated — and is the signal
 * this channel uses to prune. Any error that fails the *whole* call (auth, transport, quota)
 * throws; the delivery job's BullMQ retries and the dead-letter path decide what happens to it.
 * The sender never has to guess about those, because it never sees them as a response.
 */

import { cert, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

import type { App } from "firebase-admin/app";
import type { Messaging } from "firebase-admin/messaging";

export interface PushDevice {
  id: string;
  token: string;
  platform: "ios" | "android" | "web";
}

export interface PushMessage {
  title: string;
  body: string;
  /** Deep-link path, e.g. `/courses/{courseId}/grades`. Empty for pre-channel legacy jobs. */
  route: string;
  notificationType: string;
  dispatchLogId: string;
}

export interface PushSendResult {
  /** Device rows whose tokens FCM reported as no longer registered. The caller revokes these. */
  unregisteredDeviceIds: string[];
  /** Messages FCM accepted. */
  sent: number;
  dryRun: boolean;
}

export interface PushSender {
  send(message: PushMessage, devices: PushDevice[]): Promise<PushSendResult>;
}

export interface PushSenderLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PushSenderEnv {
  /** A Google service-account JSON string. Absent means dry-run. */
  FIREBASE_SERVICE_ACCOUNT?: string;
}

/**
 * FCM's token-level "this registration token is dead" codes. `messaging/unregistered` is the
 * legacy spelling the HTTP v1 API still surfaces for tokens minted before the FCM v1 migration.
 */
const UNREGISTERED_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/unregistered",
]);

/** Whether a per-token error means the token itself has stopped being a valid route. */
export function isUnregisteredToken(error: { code?: string }): boolean {
  return error.code !== undefined && UNREGISTERED_ERROR_CODES.has(error.code);
}

/** The `data` payload every FCM message carries. Values must be strings — FCM rejects anything else. */
export function buildDataPayload(message: PushMessage): Record<string, string> {
  const data: Record<string, string> = {
    notification_type: message.notificationType,
    dispatch_log_id: message.dispatchLogId,
  };
  // Omitted when empty rather than sent as "": a bogus deep link is worse than none.
  if (message.route !== "") {
    data.route = message.route;
  }
  return data;
}

/**
 * Build the push sender. Without a service account the sender is a dry run: it resolves like a
 * send but nothing reaches FCM, so the whole delivery pipeline (route resolution, per-user cap,
 * token pruning, dispatch-log advancement) works in development and CI without credentials.
 */
export function createFcmSender(env: PushSenderEnv, logger: PushSenderLogger): PushSender {
  const serviceAccountJson = env.FIREBASE_SERVICE_ACCOUNT;

  if (serviceAccountJson === undefined) {
    logger.warn({}, "FIREBASE_SERVICE_ACCOUNT unset — push channel running in dry-run mode");
    return {
      async send(_message: PushMessage, devices: PushDevice[]): Promise<PushSendResult> {
        return { unregisteredDeviceIds: [], sent: devices.length, dryRun: true };
      },
    };
  }

  const app = buildFirebaseApp(serviceAccountJson);
  const messaging: Messaging = getMessaging(app);

  return {
    async send(message: PushMessage, devices: PushDevice[]): Promise<PushSendResult> {
      if (devices.length === 0) {
        return { unregisteredDeviceIds: [], sent: 0, dryRun: false };
      }

      const result = await messaging.sendEachForMulticast({
        tokens: devices.map((device) => device.token),
        notification: { title: message.title, body: message.body },
        data: buildDataPayload(message),
      });

      const unregisteredDeviceIds: string[] = [];
      for (const [index, device] of devices.entries()) {
        const response = result.responses[index];
        if (
          response !== undefined &&
          !response.success &&
          response.error !== undefined &&
          isUnregisteredToken(response.error)
        ) {
          unregisteredDeviceIds.push(device.id);
        }
      }

      return { unregisteredDeviceIds, sent: result.successCount, dryRun: false };
    },
  };
}

/** Parse the service account and initialise the default Firebase app. Fails fast on a bad one. */
function buildFirebaseApp(serviceAccountJson: string): App {
  let serviceAccount: Record<string, unknown>;
  try {
    serviceAccount = JSON.parse(serviceAccountJson) as Record<string, unknown>;
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON");
  }

  const projectId =
    typeof serviceAccount.project_id === "string" ? serviceAccount.project_id : undefined;
  const clientEmail =
    typeof serviceAccount.client_email === "string" ? serviceAccount.client_email : undefined;
  const privateKey =
    typeof serviceAccount.private_key === "string" ? serviceAccount.private_key : undefined;

  if (projectId === undefined || clientEmail === undefined || privateKey === undefined) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is missing project_id, client_email or private_key");
  }

  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}
