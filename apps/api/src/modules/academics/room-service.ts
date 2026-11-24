import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import type { RoomType } from "./schemas";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoomRow {
  id: string;
  school_id: string;
  code: string;
  name: string;
  room_type: RoomType;
  capacity: number | null;
  exam_capacity: number | null;
  building: string | null;
  floor: string | null;
  virtual_url: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ListRoomsParams {
  limit: number;
  offset: number;
  is_active?: boolean;
  room_type?: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Directory of a school's rooms, ordered by code — backs the timetable builder's room picker,
 * name resolution and exam weeks. Virtual rooms are provisioned by onboarding/setup; leadership
 * adds and edits physical rooms ({@link createRoom}, {@link updateRoom}). Rooms are deactivated,
 * never deleted: timetable slots, exams and exam seats keep pointing at them. */
export async function listRooms(
  tx: TransactionSql,
  schoolId: string,
  params: ListRoomsParams,
): Promise<{ rows: RoomRow[]; total: number }> {
  const activeFilter =
    params.is_active === undefined ? tx`` : tx` AND r.is_active = ${params.is_active}`;
  const typeFilter = params.room_type
    ? tx` AND r.room_type = ${params.room_type}::app.room_type`
    : tx``;

  const [rows, countResult] = await Promise.all([
    tx<RoomRow[]>`
      SELECT r.id, r.school_id, r.code, r.name, r.room_type, r.capacity, r.exam_capacity,
             r.building, r.floor, r.virtual_url, r.is_active,
             r.created_at, r.updated_at
      FROM app.rooms AS r
      WHERE r.school_id = ${schoolId}
        ${activeFilter}
        ${typeFilter}
      ORDER BY r.code ASC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `,
    tx<{ count: string }[]>`
      SELECT count(*)::int AS count
      FROM app.rooms AS r
      WHERE r.school_id = ${schoolId}
        ${activeFilter}
        ${typeFilter}
    `,
  ]);

  return { rows, total: Number(countResult[0]?.count ?? 0) };
}

// ---------------------------------------------------------------------------
// Writes (leadership, timetable:manage)
// ---------------------------------------------------------------------------

const ROOM_COLUMNS = `id, school_id, code, name, room_type, capacity, exam_capacity, building, floor,
  virtual_url, is_active, created_at, updated_at`;

export interface RoomCreateInput {
  code: string;
  name: string;
  building: string;
  floor?: string | null | undefined;
  capacity?: number | null | undefined;
  exam_capacity?: number | null | undefined;
}

export interface RoomUpdateInput {
  name?: string | undefined;
  building?: string | undefined;
  floor?: string | null | undefined;
  capacity?: number | null | undefined;
  exam_capacity?: number | null | undefined;
  is_active?: boolean | undefined;
}

/** Add a physical room. 409 CONFLICT_DUPLICATE_ENTRY when the code is already used. */
export async function createRoom(
  tx: TransactionSql,
  schoolId: string,
  input: RoomCreateInput,
): Promise<RoomRow> {
  let row: RoomRow | undefined;
  try {
    [row] = await tx.savepoint(
      (sp) => sp<RoomRow[]>`
        INSERT INTO app.rooms (
          school_id, code, name, room_type, capacity, exam_capacity, building, floor
        )
        VALUES (
          ${schoolId}::uuid, ${input.code}, ${input.name}, 'physical', ${input.capacity ?? null},
          ${input.exam_capacity ?? null}, ${input.building}, ${input.floor ?? null}
        )
        RETURNING ${sp.unsafe(ROOM_COLUMNS)}
      `,
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new CodedHttpException(
        409,
        ERROR_CODES.CONFLICT_DUPLICATE_ENTRY,
        `The school already has a room with code "${input.code}"`,
      );
    }
    throw error;
  }
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "rooms",
    targetId: row!.id,
    newValues: { ...input },
  });
  return row!;
}

/** Edit a room. A virtual room keeps its link and takes no building or floor. */
export async function updateRoom(
  tx: TransactionSql,
  schoolId: string,
  roomId: string,
  input: RoomUpdateInput,
): Promise<RoomRow> {
  const [before] = await tx<RoomRow[]>`
    SELECT ${tx.unsafe(ROOM_COLUMNS)} FROM app.rooms
    WHERE id = ${roomId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!before) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Room not found");
  }
  if (
    before.room_type === "virtual" &&
    (input.building !== undefined || (input.floor !== undefined && input.floor !== null))
  ) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "A virtual room has no building or floor",
    );
  }
  const next = {
    name: input.name ?? before.name,
    building: input.building ?? before.building,
    floor: input.floor === undefined ? before.floor : input.floor,
    capacity: input.capacity === undefined ? before.capacity : input.capacity,
    exam_capacity: input.exam_capacity === undefined ? before.exam_capacity : input.exam_capacity,
    is_active: input.is_active ?? before.is_active,
  };
  const [row] = await tx<RoomRow[]>`
    UPDATE app.rooms
    SET name = ${next.name}, building = ${next.building}, floor = ${next.floor},
        capacity = ${next.capacity}, exam_capacity = ${next.exam_capacity},
        is_active = ${next.is_active}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${roomId}::uuid AND school_id = ${schoolId}::uuid
    RETURNING ${tx.unsafe(ROOM_COLUMNS)}
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "rooms",
    targetId: roomId,
    oldValues: {
      name: before.name,
      building: before.building,
      floor: before.floor,
      capacity: before.capacity,
      exam_capacity: before.exam_capacity,
      is_active: before.is_active,
    },
    newValues: next,
  });
  return row!;
}
