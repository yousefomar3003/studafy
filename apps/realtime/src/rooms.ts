import { parseRoomKeyParts } from "./protocol";

import type { ParsedRoomKey, RoomKey } from "./protocol";
import type { Role } from "@studafy/constants";

export type { ParsedRoomKey } from "./protocol";

/** The school-wide room — every connection for a tenant, regardless of role. */
export function schoolRoomKey(schoolId: string): RoomKey {
  return `school:${schoolId}`;
}

/** The room for every connection of a given role within a school. */
export function roleRoomKey(schoolId: string, role: Role): RoomKey {
  return `school:${schoolId}:role:${role}`;
}

/** The room for a single user's connection(s) within a school — for direct, targeted delivery. */
export function userRoomKey(schoolId: string, userId: string): RoomKey {
  return `school:${schoolId}:user:${userId}`;
}

/**
 * Inverse of {@link schoolRoomKey}/{@link roleRoomKey}/{@link userRoomKey}. Callers must pass an
 * already-validated {@link RoomKey}. Every variant carries `schoolId`, since that field alone is
 * what authorization checks (join/leave must stay within the caller's own school) need.
 */
export function parseRoomKey(room: RoomKey): ParsedRoomKey {
  const parsed = parseRoomKeyParts(room);
  if (!parsed) {
    throw new Error(`"${room}" is not a valid room key`);
  }
  return parsed;
}

/**
 * Tracks which clients belong to which rooms. Generic over the client reference type so it has no
 * dependency on Bun, Hono, or WebSocket — the gateway supplies whatever stable per-connection
 * identity it has (see src/app.ts for why that must be the raw socket, not a per-event wrapper).
 */
export interface RoomManager<Client> {
  join(room: RoomKey, client: Client): void;
  leave(room: RoomKey, client: Client): void;
  /** Removes a client from every room it belongs to — called once, on disconnect. */
  leaveAll(client: Client): void;
  members(room: RoomKey): ReadonlySet<Client>;
  roomsOf(client: Client): ReadonlySet<RoomKey>;
}

export function createRoomManager<Client>(): RoomManager<Client> {
  const roomToClients = new Map<RoomKey, Set<Client>>();
  const clientToRooms = new Map<Client, Set<RoomKey>>();

  return {
    join(room, client) {
      let clients = roomToClients.get(room);
      if (!clients) {
        clients = new Set();
        roomToClients.set(room, clients);
      }
      clients.add(client);

      let rooms = clientToRooms.get(client);
      if (!rooms) {
        rooms = new Set();
        clientToRooms.set(client, rooms);
      }
      rooms.add(room);
    },

    leave(room, client) {
      roomToClients.get(room)?.delete(client);
      if (roomToClients.get(room)?.size === 0) {
        roomToClients.delete(room);
      }
      clientToRooms.get(client)?.delete(room);
    },

    leaveAll(client) {
      const rooms = clientToRooms.get(client);
      if (!rooms) {
        return;
      }
      for (const room of rooms) {
        roomToClients.get(room)?.delete(client);
        if (roomToClients.get(room)?.size === 0) {
          roomToClients.delete(room);
        }
      }
      clientToRooms.delete(client);
    },

    members(room) {
      return roomToClients.get(room) ?? new Set();
    },

    roomsOf(client) {
      return clientToRooms.get(client) ?? new Set();
    },
  };
}
