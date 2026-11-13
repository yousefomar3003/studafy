// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createRedisSubscriber } from "./connection";

describe("createRedisSubscriber", () => {
  test("does not connect eagerly", () => {
    const connection = createRedisSubscriber({ REDIS_URL: "redis://localhost:6379" });
    try {
      expect(connection.options.lazyConnect).toBe(true);
      expect(connection.status).toBe("wait");
    } finally {
      connection.disconnect();
    }
  });
});
