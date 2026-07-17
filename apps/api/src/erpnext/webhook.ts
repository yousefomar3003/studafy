import { ERPNEXT_DOC_EVENT_MAP } from "@studafy/constants";
import { Hono } from "hono";
import { z } from "zod";

import { verifyWebhookSignature } from "./signature";

import type { Database } from "../db";
import type { Logger } from "../logger";
import type { AppEnv } from "../middleware/requestId";

const webhookBodySchema = z.object({
  event_id: z.string().min(1),
  doctype: z.string().min(1),
  action: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});

type WebhookBody = z.infer<typeof webhookBodySchema>;

function resolveEventName(doctype: string, action: string): string | undefined {
  const key = `${doctype}-${action}`;
  return ERPNEXT_DOC_EVENT_MAP[key];
}

/**
 * Project an ERPNext document into the appropriate finance cache table. Best-effort: if it fails,
 * the outbox event is still relayed and a downstream consumer can retry.
 */
async function projectToCache(
  db: Database,
  schoolId: string,
  eventName: string,
  data: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  const docname = String(data.name ?? data.docname ?? "");
  const status = String(data.status ?? data.docstatus ?? "");
  if (!docname) return;

  switch (eventName) {
    case "erpnext.invoiceSubmitted":
    case "erpnext.creditNoteIssued": {
      const totalAmount = Number(data.grand_total ?? data.total ?? 0);
      const outstandingAmount = Number(
        data.outstanding_amount ?? data.grand_total ?? data.total ?? 0,
      );
      await db.unsafe(
        `INSERT INTO app.invoice_cache (
          school_id, student_id, currency_id, erpnext_docname, erpnext_status,
          total_amount_minor, outstanding_amount_minor, issued_date, due_date,
          erpnext_payload, last_synced_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
        ON CONFLICT (school_id, erpnext_docname) DO UPDATE SET
          erpnext_status = EXCLUDED.erpnext_status,
          total_amount_minor = EXCLUDED.total_amount_minor,
          outstanding_amount_minor = EXCLUDED.outstanding_amount_minor,
          erpnext_payload = EXCLUDED.erpnext_payload,
          last_synced_at = EXCLUDED.last_synced_at,
          updated_at = NOW()`,
        [
          schoolId,
          String(data.student_id ?? data.customer ?? ""),
          String(data.currency ?? data.currency_id ?? ""),
          docname,
          status,
          totalAmount,
          outstandingAmount,
          String(data.posting_date ?? data.transaction_date ?? now),
          String(data.due_date ?? ""),
          JSON.stringify(data),
          now,
        ],
      );
      break;
    }
    case "erpnext.paymentReceived": {
      const amount = Number(data.paid_amount ?? data.total_amount ?? 0);
      await db.unsafe(
        `INSERT INTO app.payment_cache (
          school_id, student_id, currency_id, erpnext_docname, erpnext_status,
          amount_minor, payment_date, erpnext_payload, last_synced_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        ON CONFLICT (school_id, erpnext_docname) DO UPDATE SET
          erpnext_status = EXCLUDED.erpnext_status,
          amount_minor = EXCLUDED.amount_minor,
          erpnext_payload = EXCLUDED.erpnext_payload,
          last_synced_at = EXCLUDED.last_synced_at,
          updated_at = NOW()`,
        [
          schoolId,
          String(data.student_id ?? data.party ?? ""),
          String(data.currency ?? data.currency_id ?? ""),
          docname,
          status,
          amount,
          String(data.posting_date ?? data.transaction_date ?? now),
          JSON.stringify(data),
          now,
        ],
      );
      break;
    }
    case "erpnext.feeDue": {
      const totalAmount = Number(data.total_amount ?? 0);
      await db.unsafe(
        `INSERT INTO app.fee_schedule_cache (
          school_id, academic_year_id, term_id, currency_id, erpnext_docname,
          erpnext_status, title, total_amount_minor, erpnext_payload, last_synced_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
        ON CONFLICT (school_id, erpnext_docname) DO UPDATE SET
          erpnext_status = EXCLUDED.erpnext_status,
          title = EXCLUDED.title,
          total_amount_minor = EXCLUDED.total_amount_minor,
          erpnext_payload = EXCLUDED.erpnext_payload,
          last_synced_at = EXCLUDED.last_synced_at,
          updated_at = NOW()`,
        [
          schoolId,
          String(data.academic_year_id ?? ""),
          String(data.term_id ?? ""),
          String(data.currency ?? data.currency_id ?? ""),
          docname,
          status,
          String(data.fee_name ?? data.title ?? docname),
          totalAmount,
          JSON.stringify(data),
          now,
        ],
      );
      break;
    }
  }
}

/**
 * Build the Hono route group for ERPNext webhook ingestion.
 */
export function erpNextWebhookRoutes(db: Database, logger: Logger): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post("/erpnext/webhooks", async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header("x-erpnext-signature") ?? null;
    const webhookSecret = process.env.ERPNEXT_WEBHOOK_SECRET;

    if (!webhookSecret) {
      logger.error({}, "ERPNEXT_WEBHOOK_SECRET not configured");
      return c.json({ error: "Webhook secret not configured" }, 500);
    }

    if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      logger.warn({ signature }, "webhook signature verification failed");
      return c.json({ error: "Invalid signature" }, 401);
    }

    let body: WebhookBody;
    try {
      body = webhookBodySchema.parse(JSON.parse(rawBody));
    } catch (err) {
      logger.warn({ err }, "webhook body validation failed");
      return c.json({ error: "Invalid webhook body" }, 400);
    }

    const eventName = resolveEventName(body.doctype, body.action);
    if (!eventName) {
      return c.json({ ok: true }, 200);
    }

    const schoolId = String(body.data.school_id ?? body.data.custom_school_id ?? "");
    if (!schoolId) {
      logger.warn({ event_id: body.event_id }, "webhook missing school_id");
      return c.json({ error: "Missing school_id" }, 400);
    }

    try {
      await db.begin(async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

        const dedupResult = await tx`
          INSERT INTO app.erpnext_webhook_dedup (school_id, event_id, doc_type, action)
          VALUES (${schoolId}, ${body.event_id}, ${body.doctype}, ${body.action})
          ON CONFLICT (school_id, event_id) DO NOTHING
          RETURNING id
        `;

        if (dedupResult.length === 0) {
          return;
        }

        await tx`
          INSERT INTO app.outbox_events (school_id, event_name, payload)
          VALUES (${schoolId}, ${eventName}, ${JSON.stringify(body.data)}::jsonb)
        `;
      });

      await projectToCache(db, schoolId, eventName, body.data as Record<string, unknown>);
    } catch (err) {
      logger.error({ err, event_id: body.event_id }, "webhook ingestion failed");
      return c.json({ error: "Internal error" }, 500);
    }

    return c.json({ ok: true }, 200);
  });

  return routes;
}
