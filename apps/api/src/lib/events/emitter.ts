import { withClientSpan } from "@studafy/observability";

import { eventPayloadSchemas, type EventPayloadMap } from "./schemas";

import type { DomainEvent } from "@studafy/constants";
import type { JSONValue, TransactionSql } from "postgres";

/**
 * Emit a domain event into the outbox within the given transaction. The school_id is read from
 * the `app.school_id` GUC, which must be set by the enclosing `withTenantTx` (or equivalent).
 *
 * Throws if:
 * - `tx` is not inside a transaction that has set `app.school_id`
 * - `payload` fails the per-event Zod schema validation
 *
 * Wrapped in a CLIENT span (ST-260, `outbox.emit`) tagged with the event name: every caller of this
 * one function is what gives the trace its "outbox" segment — see `enqueue-dispatch.ts`'s own
 * header for why the grades-published path enqueues its BullMQ job directly rather than consuming
 * this row, so the span here is the trace's only literal record of the outbox write itself.
 */
export async function emit<E extends DomainEvent>(
  tx: TransactionSql,
  event: E,
  payload: EventPayloadMap[E],
): Promise<void> {
  const schema = eventPayloadSchemas[event];
  const validated = schema.parse(payload);

  await withClientSpan("outbox.emit", { "studafy.event_name": event }, async () => {
    // tx.json(), not JSON.stringify() + ::jsonb. With an explicit ::jsonb cast postgres.js infers
    // the parameter type as json and encodes the already-serialized string a second time, so the
    // column stores a jsonb *string* (`jsonb_typeof` = 'string') rather than an object.
    // app.outbox_events has no CHECK that would catch it, so every consumer downstream silently
    // fails its payload schema instead. Same trap the ERPNext ingester, the audit emitters and the
    // notification workers all document at their own INSERT sites.
    const body = tx.json(validated as JSONValue);

    await tx`
      INSERT INTO app.outbox_events (school_id, event_name, payload)
      VALUES (
        current_setting('app.school_id')::uuid,
        ${event},
        ${body}
      )
    `;
  });
}
