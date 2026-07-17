import { eventPayloadSchemas, type EventPayloadMap } from "./schemas";

import type { DomainEvent } from "@studafy/constants";
import type { TransactionSql } from "postgres";

/**
 * Emit a domain event into the outbox within the given transaction. The school_id is read from
 * the `app.school_id` GUC, which must be set by the enclosing `withTenantTx` (or equivalent).
 *
 * Throws if:
 * - `tx` is not inside a transaction that has set `app.school_id`
 * - `payload` fails the per-event Zod schema validation
 */
export async function emit<E extends DomainEvent>(
  tx: TransactionSql,
  event: E,
  payload: EventPayloadMap[E],
): Promise<void> {
  const schema = eventPayloadSchemas[event];
  const validated = schema.parse(payload);

  await tx`
    INSERT INTO app.outbox_events (school_id, event_name, payload)
    VALUES (
      current_setting('app.school_id')::uuid,
      ${event},
      ${JSON.stringify(validated)}::jsonb
    )
  `;
}
