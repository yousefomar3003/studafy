import { ERROR_CODES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type {
  DisciplineIncidentType,
  DisciplineIncidentStatus,
  DisciplineSeverity,
  DisciplineActionType,
  DisciplineActionStatus,
  CreateIncidentBody,
  UpdateIncidentBody,
  CreateActionBody,
  UpdateActionBody,
} from "./schemas";
import type { TransactionSql } from "postgres";

export interface IncidentRow {
  id: string;
  school_id: string;
  student_id: string;
  class_id: string | null;
  reporter_user_id: string;
  incident_type: DisciplineIncidentType;
  severity: DisciplineSeverity;
  status: DisciplineIncidentStatus;
  title: string;
  description: string | null;
  incident_at: Date;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ActionRow {
  id: string;
  school_id: string;
  incident_id: string;
  action_type: DisciplineActionType;
  action_by_user_id: string;
  status: DisciplineActionStatus;
  description: string | null;
  effective_from: string | null;
  effective_until: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ListIncidentsParams {
  limit: number;
  offset: number;
  student_id?: string;
  class_id?: string;
  status?: string;
  severity?: string;
}

export interface ListActionsParams {
  limit: number;
  offset: number;
}

const INCIDENT_COLUMNS = `
  id, school_id, student_id, class_id, reporter_user_id,
  incident_type::text AS incident_type, severity::text AS severity, status::text AS status,
  title, description, incident_at, resolved_at, created_at, updated_at
`;

const ACTION_COLUMNS = `
  id, school_id, incident_id,
  action_type::text AS action_type, action_by_user_id, status::text AS status,
  description, effective_from::text AS effective_from,
  effective_until::text AS effective_until, created_at, updated_at
`;

const VALID_INCIDENT_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  reported: new Set(["under_review", "resolved", "escalated", "closed"]),
  under_review: new Set(["resolved", "escalated", "closed"]),
  resolved: new Set(["closed"]),
  escalated: new Set(["under_review", "resolved", "closed"]),
  closed: new Set(),
};

const VALID_ACTION_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending: new Set(["active", "revoked"]),
  active: new Set(["completed", "revoked"]),
  completed: new Set(),
  revoked: new Set(),
};

function parseIncidentRow(row: Record<string, unknown>): IncidentRow {
  return {
    id: row.id as string,
    school_id: row.school_id as string,
    student_id: row.student_id as string,
    class_id: row.class_id as string | null,
    reporter_user_id: row.reporter_user_id as string,
    incident_type: row.incident_type as DisciplineIncidentType,
    severity: row.severity as DisciplineSeverity,
    status: row.status as DisciplineIncidentStatus,
    title: row.title as string,
    description: row.description as string | null,
    incident_at: row.incident_at as Date,
    resolved_at: row.resolved_at as Date | null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

function parseActionRow(row: Record<string, unknown>): ActionRow {
  return {
    id: row.id as string,
    school_id: row.school_id as string,
    incident_id: row.incident_id as string,
    action_type: row.action_type as DisciplineActionType,
    action_by_user_id: row.action_by_user_id as string,
    status: row.status as DisciplineActionStatus,
    description: row.description as string | null,
    effective_from: row.effective_from as string | null,
    effective_until: row.effective_until as string | null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

export async function getParentDisciplineVisibility(
  tx: TransactionSql,
  schoolId: string,
): Promise<boolean> {
  const [row] = await tx<{ visible: boolean }[]>`
    SELECT parent_discipline_visibility AS visible
    FROM app.school_settings
    WHERE school_id = ${schoolId}::uuid
  `;
  return row?.visible ?? false;
}

export async function listIncidents(
  tx: TransactionSql,
  schoolId: string,
  params: ListIncidentsParams,
): Promise<{ rows: IncidentRow[]; total: number }> {
  const studentFilter = params.student_id
    ? tx` AND i.student_id = ${params.student_id}::uuid`
    : tx``;
  const classFilter = params.class_id ? tx` AND i.class_id = ${params.class_id}::uuid` : tx``;
  const statusFilter = params.status
    ? tx` AND i.status = ${params.status}::app.discipline_incident_status`
    : tx``;
  const severityFilter = params.severity
    ? tx` AND i.severity = ${params.severity}::app.discipline_severity`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(INCIDENT_COLUMNS)}
      FROM app.discipline_incidents i
      WHERE i.school_id = ${schoolId}::uuid
        ${studentFilter}
        ${classFilter}
        ${statusFilter}
        ${severityFilter}
      ORDER BY i.incident_at DESC, i.id DESC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.discipline_incidents i
      WHERE i.school_id = ${schoolId}::uuid
        ${studentFilter}
        ${classFilter}
        ${statusFilter}
        ${severityFilter}
    `,
  ]);

  return {
    rows: rows.map(parseIncidentRow),
    total: Number(countResult[0]?.count ?? 0),
  };
}

export async function getIncident(
  tx: TransactionSql,
  schoolId: string,
  incidentId: string,
): Promise<IncidentRow | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(INCIDENT_COLUMNS)}
    FROM app.discipline_incidents
    WHERE id = ${incidentId}::uuid AND school_id = ${schoolId}::uuid
  `;
  return row ? parseIncidentRow(row) : undefined;
}

export async function createIncident(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: CreateIncidentBody,
): Promise<IncidentRow> {
  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.discipline_incidents
      (school_id, student_id, class_id, reporter_user_id,
       incident_type, severity, title, description, incident_at)
    VALUES (
      ${schoolId}::uuid, ${params.student_id}::uuid,
      ${params.class_id ?? null}::uuid, ${userId}::uuid,
      ${params.incident_type}::app.discipline_incident_type,
      ${params.severity}::app.discipline_severity,
      ${params.title}, ${params.description ?? null},
      ${params.incident_at}::timestamptz
    )
    RETURNING ${tx.unsafe(INCIDENT_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(500, { message: "Failed to create incident" });
  }

  const incident = parseIncidentRow(row);

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "discipline_incidents",
    targetId: incident.id,
    newValues: {
      student_id: params.student_id,
      class_id: params.class_id ?? null,
      incident_type: params.incident_type,
      severity: params.severity,
      title: params.title,
      description: params.description ?? null,
      incident_at: params.incident_at,
      status: "reported",
    },
  });

  return incident;
}

export async function updateIncident(
  tx: TransactionSql,
  schoolId: string,
  incidentId: string,
  params: UpdateIncidentBody,
): Promise<IncidentRow> {
  const existing = await getIncident(tx, schoolId, incidentId);
  if (!existing) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.DISCIPLINE_INCIDENT_NOT_FOUND,
      "Discipline incident not found",
    );
  }

  const severity = params.severity ?? existing.severity;
  const description = params.description !== undefined ? params.description : existing.description;

  const status = params.status ?? existing.status;
  if (params.status && params.status !== existing.status) {
    const allowed = VALID_INCIDENT_TRANSITIONS[existing.status];
    if (!allowed || !allowed.has(params.status)) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.DISCIPLINE_INCIDENT_INVALID_STATUS_TRANSITION,
        `Cannot transition incident from '${existing.status}' to '${params.status}'`,
      );
    }
  }

  const [row] = await tx<Record<string, unknown>[]>`
    UPDATE app.discipline_incidents SET
      severity = ${severity}::app.discipline_severity,
      status = ${status}::app.discipline_incident_status,
      description = ${description},
      resolved_at = CASE
        WHEN ${status === "resolved" && existing.status !== "resolved"} THEN CURRENT_TIMESTAMP
        WHEN ${status !== "resolved"} THEN NULL
        ELSE resolved_at
      END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${incidentId}::uuid AND school_id = ${schoolId}::uuid
    RETURNING ${tx.unsafe(INCIDENT_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Discipline incident not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "discipline_incidents",
    targetId: incidentId,
    oldValues: {
      status: existing.status,
      severity: existing.severity,
      description: existing.description,
    },
    newValues: {
      status,
      severity,
      description,
    },
  });

  return parseIncidentRow(row);
}

export async function resolveIncident(
  tx: TransactionSql,
  schoolId: string,
  incidentId: string,
  _resolutionDescription?: string,
): Promise<IncidentRow> {
  const existing = await getIncident(tx, schoolId, incidentId);
  if (!existing) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.DISCIPLINE_INCIDENT_NOT_FOUND,
      "Discipline incident not found",
    );
  }

  const allowed = VALID_INCIDENT_TRANSITIONS[existing.status];
  if (!allowed || !allowed.has("resolved")) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.DISCIPLINE_INCIDENT_INVALID_STATUS_TRANSITION,
      `Cannot resolve incident in '${existing.status}' status`,
    );
  }

  const [row] = await tx<Record<string, unknown>[]>`
    UPDATE app.discipline_incidents SET
      status = 'resolved'::app.discipline_incident_status,
      resolved_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${incidentId}::uuid AND school_id = ${schoolId}::uuid
    RETURNING ${tx.unsafe(INCIDENT_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Discipline incident not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "discipline_incidents",
    targetId: incidentId,
    oldValues: { status: existing.status },
    newValues: { status: "resolved", resolved_at: new Date().toISOString() },
  });

  return parseIncidentRow(row);
}

export async function listActions(
  tx: TransactionSql,
  schoolId: string,
  incidentId: string,
  params: ListActionsParams,
): Promise<{ rows: ActionRow[]; total: number }> {
  const [rows, countResult] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(ACTION_COLUMNS)}
      FROM app.discipline_actions
      WHERE school_id = ${schoolId}::uuid AND incident_id = ${incidentId}::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.discipline_actions
      WHERE school_id = ${schoolId}::uuid AND incident_id = ${incidentId}::uuid
    `,
  ]);

  return {
    rows: rows.map(parseActionRow),
    total: Number(countResult[0]?.count ?? 0),
  };
}

export async function createAction(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  incidentId: string,
  params: CreateActionBody,
): Promise<ActionRow> {
  const incident = await getIncident(tx, schoolId, incidentId);
  if (!incident) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.DISCIPLINE_INCIDENT_NOT_FOUND,
      "Discipline incident not found",
    );
  }

  if (incident.status === "resolved" || incident.status === "closed") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.DISCIPLINE_INCIDENT_INVALID_STATUS_TRANSITION,
      `Cannot add actions to a ${incident.status} incident`,
    );
  }

  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.discipline_actions
      (school_id, incident_id, action_type, action_by_user_id, description,
       effective_from, effective_until)
    VALUES (
      ${schoolId}::uuid, ${incidentId}::uuid,
      ${params.action_type}::app.discipline_action_type,
      ${userId}::uuid,
      ${params.description ?? null},
      ${params.effective_from ?? null}::date,
      ${params.effective_until ?? null}::date
    )
    RETURNING ${tx.unsafe(ACTION_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(500, { message: "Failed to create action" });
  }

  const action = parseActionRow(row);

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "discipline_actions",
    targetId: action.id,
    newValues: {
      incident_id: incidentId,
      action_type: params.action_type,
      description: params.description ?? null,
      effective_from: params.effective_from ?? null,
      effective_until: params.effective_until ?? null,
    },
  });

  return action;
}

export async function updateAction(
  tx: TransactionSql,
  schoolId: string,
  incidentId: string,
  actionId: string,
  params: UpdateActionBody,
): Promise<ActionRow> {
  const incident = await getIncident(tx, schoolId, incidentId);
  if (!incident) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.DISCIPLINE_INCIDENT_NOT_FOUND,
      "Discipline incident not found",
    );
  }

  const [existing] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(ACTION_COLUMNS)}
    FROM app.discipline_actions
    WHERE id = ${actionId}::uuid AND school_id = ${schoolId}::uuid
      AND incident_id = ${incidentId}::uuid
  `;

  if (!existing) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.DISCIPLINE_ACTION_NOT_FOUND,
      "Discipline action not found",
    );
  }

  const existingAction = parseActionRow(existing);
  const status = params.status ?? existingAction.status;
  const description =
    params.description !== undefined ? params.description : existingAction.description;
  const effectiveFrom =
    params.effective_from !== undefined ? params.effective_from : existingAction.effective_from;
  const effectiveUntil =
    params.effective_until !== undefined ? params.effective_until : existingAction.effective_until;

  if (params.status && params.status !== existingAction.status) {
    const allowed = VALID_ACTION_TRANSITIONS[existingAction.status];
    if (!allowed || !allowed.has(params.status)) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.DISCIPLINE_ACTION_INVALID_STATUS_TRANSITION,
        `Cannot transition action from '${existingAction.status}' to '${params.status}'`,
      );
    }
  }

  const [row] = await tx<Record<string, unknown>[]>`
    UPDATE app.discipline_actions SET
      status = ${status}::app.discipline_action_status,
      description = ${description},
      effective_from = ${effectiveFrom}::date,
      effective_until = ${effectiveUntil}::date,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${actionId}::uuid AND school_id = ${schoolId}::uuid
    RETURNING ${tx.unsafe(ACTION_COLUMNS)}
  `;

  if (!row) {
    throw new HTTPException(404, { message: "Discipline action not found" });
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "discipline_actions",
    targetId: actionId,
    oldValues: {
      status: existingAction.status,
      description: existingAction.description,
    },
    newValues: {
      status,
      description,
    },
  });

  return parseActionRow(row);
}

export async function getParentChildren(
  tx: TransactionSql,
  schoolId: string,
  parentUserId: string,
): Promise<string[]> {
  const rows = await tx<{ student_id: string }[]>`
    SELECT student_id::text
    FROM app.parent_child_links
    WHERE school_id = ${schoolId}::uuid AND parent_user_id = ${parentUserId}::uuid
  `;
  return rows.map((r) => r.student_id);
}

export async function getParentResolvedIncidents(
  tx: TransactionSql,
  schoolId: string,
  studentIds: string[],
  params: ListIncidentsParams,
): Promise<{ rows: IncidentRow[]; total: number }> {
  if (studentIds.length === 0) {
    return { rows: [], total: 0 };
  }

  const [rows, countResult] = await Promise.all([
    tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(INCIDENT_COLUMNS)}
      FROM app.discipline_incidents
      WHERE school_id = ${schoolId}::uuid
        AND student_id = ANY(${studentIds}::uuid[])
        AND status = 'resolved'
      ORDER BY incident_at DESC, id DESC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.discipline_incidents
      WHERE school_id = ${schoolId}::uuid
        AND student_id = ANY(${studentIds}::uuid[])
        AND status = 'resolved'
    `,
  ]);

  return {
    rows: rows.map(parseIncidentRow),
    total: Number(countResult[0]?.count ?? 0),
  };
}
