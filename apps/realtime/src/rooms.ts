import { ROOM_KEY_PATTERN } from "./protocol";

import type { RoomKey } from "./protocol";
import type { Role } from "@studafy/constants";

/** Builds the canonical room key for a school/role pair — the sole place this format is written. */
export function roomKey(schoolId: string, role: Role): RoomKey {
  return `school:${schoolId}:role:${role}`;
}

/** Inverse of {@link roomKey}. Callers must pass an already-validated {@link RoomKey}. */
export function parseRoomKey(room: RoomKey): { schoolId: string; role: string } {
  const match = room.match(ROOM_KEY_PATTERN);
  if (!match) {
    throw new Error(`"${room}" is not a valid room key`);
  }
  return { schoolId: match[1], role: match[2] };
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
