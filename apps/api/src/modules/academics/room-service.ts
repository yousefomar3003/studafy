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

/** Read-only directory of a school's rooms, ordered by code — backs the timetable builder's room
 * picker and name resolution. Rooms are created by the onboarding/setup flow directly against the
 * database; there is no create/update/delete route here because nothing in this ticket needs one. */
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
      SELECT r.id, r.school_id, r.code, r.name, r.room_type, r.capacity,
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
