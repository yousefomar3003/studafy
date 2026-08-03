// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { beforeEach, describe, expect, test } from "bun:test";

import {
  incrementDropped,
  incrementReceived,
  incrementRoomDeliveries,
  resetMetrics,
  snapshot,
} from "./metrics";

beforeEach(() => {
  resetMetrics();
});

describe("fan-out metrics", () => {
  test("starts at zero", () => {
    expect(snapshot()).toEqual({ received: 0, roomDeliveries: 0, dropped: 0 });
  });

  test("incrementReceived adds one per call", () => {
    incrementReceived();
    incrementReceived();
    expect(snapshot().received).toBe(2);
  });

  test("incrementRoomDeliveries adds to the counter", () => {
    incrementRoomDeliveries(2);
    incrementRoomDeliveries(1);
    expect(snapshot().roomDeliveries).toBe(3);
  });

  test("incrementDropped adds one per call", () => {
    incrementDropped();
    expect(snapshot().dropped).toBe(1);
  });

  test("resetMetrics clears everything", () => {
    incrementReceived();
    incrementRoomDeliveries(4);
    incrementDropped();
    resetMetrics();
    expect(snapshot()).toEqual({ received: 0, roomDeliveries: 0, dropped: 0 });
  });
});
