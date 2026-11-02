// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createRedisConnection } from "./connection";

describe("createRedisConnection", () => {
  test("sets the options BullMQ requires and does not connect eagerly", () => {
    const connection = createRedisConnection({ REDIS_URL: "redis://localhost:6379" });
    try {
      expect(connection.options.maxRetriesPerRequest).toBeNull();
      expect(connection.options.lazyConnect).toBe(true);
      expect(connection.status).toBe("wait");
    } finally {
      connection.disconnect();
    }
  });
});
