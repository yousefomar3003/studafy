import { isMemberPasswordAccount } from "../auth/services/member-password-service";

import { findActiveStoreSubscriptions } from "./store-subscriptions";

import type { ActiveStoreSubscription } from "./store-subscriptions";
import type { TransactionSql } from "postgres";

export interface AccountProfileRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
  /** The member IDs the user signs in with (one per kind, e.g. a TCH and a PAR code); empty for email-only users. */
  member_ids: string[];
  /** When the user's scheduled deletion runs (000143); null when none is scheduled. */
  deletion_due_at: Date | null;
  /** Whether deleting this account asks for its member ID and password. */
  deletion_requires_member_credentials: boolean;
  /** Live App Store / Google Play AI add-ons, own or a linked child's, that deletion leaves billing. */
  active_store_subscriptions: ActiveStoreSubscription[];
  /** The legal documents the user last accepted (000188); null until they first accept. */
  terms_version: string | null;
  privacy_version: string | null;
  legal_accepted_at: Date | null;
  school_id: string;
  school_name: string;
}

/**
 * The caller's own identity for the portal header: name, contact address, member IDs and the school the
 * session is signed in to. Runs inside the caller's tenant transaction, so RLS scopes both tables
 * to that school; `undefined` means the user row is gone (deleted mid-session).
 */
export async function getAccountProfile(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
): Promise<AccountProfileRow | undefined> {
  const [row] = await tx<
    Omit<AccountProfileRow, "deletion_requires_member_credentials" | "active_store_subscriptions">[]
  >`
    SELECT u.id::text AS user_id, u.display_name, u.email,
           ARRAY(
             SELECT mc.code FROM app.member_codes mc
              WHERE mc.user_id = u.id AND mc.school_id = u.school_id
              ORDER BY mc.kind
           ) AS member_ids,
           u.deletion_due_at,
           u.terms_version, u.privacy_version, u.legal_accepted_at,
           s.id::text AS school_id, s.name AS school_name
      FROM app.users u
      JOIN app.schools s ON s.id = u.school_id
     WHERE u.id = ${userId}::uuid AND u.school_id = ${schoolId}::uuid
  `;
  if (!row) return undefined;
  return {
    ...row,
    deletion_requires_member_credentials: await isMemberPasswordAccount(tx, userId),
    active_store_subscriptions: await findActiveStoreSubscriptions(tx, userId),
  };
}
