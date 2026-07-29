import { describe, expect, test } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in

import { bootstrapErpNextSite, teardownErpNextSite } from "./bootstrap";
import { ErpNextClient, ErpNextError } from "./client";

import type { SiteBootstrapParams } from "./bootstrap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(): ErpNextClient {
  return new ErpNextClient({
    baseUrl: "https://test.erpnext.com",
    apiKey: "test_api_key:test_secret",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bootstrapErpNextSite", () => {
  test("returns correct site config on success", async () => {
    const client = createMockClient();
    const postCalls: unknown[][] = [];
    let putCalled = false;

    const originalPost = client.post.bind(client);
    const originalPut = client.put.bind(client);
    client.post = (async (path: string, body?: unknown) => {
      postCalls.push([path, body]);
      if (path.includes("/resource/Company")) {
        return { data: { name: "SPRI Company" }, status: 200, headers: new Headers() };
      }
      return { data: {}, status: 200, headers: new Headers() };
    }) as typeof client.post;
    client.put = (async () => {
      return { data: {}, status: 200, headers: new Headers() };
    }) as typeof client.put;

    const params: SiteBootstrapParams = {
      schoolId: "00000000-0000-0000-0000-000000000001",
      slug: "springfield-academy",
      country: "United States",
      currency: "USD",
      adminEmail: "admin@springfield.edu",
    };

    const result = await bootstrapErpNextSite(client, params);

    expect(result.siteName).toBe("springfield-academy.erpnext.studafy.com");
    expect(result.companyName).toBe("springfield-academy");
    expect(result.companyAbbr).toBe("SPRI");
    expect(result.companyId).toBe("SPRI Company");

    expect(putCalled).toBe(true);
    expect(postCalls.length).toBeGreaterThanOrEqual(2);
    expect(postCalls[0][0]).toContain("/api/method/erpnext");
    expect(postCalls[1][0]).toBe("/api/resource/Company");

    client.post = originalPost;
    client.put = originalPut;
  });

  test("propagates ErpNextError from site creation", async () => {
    const client = createMockClient();

    client.post = (async () => {
      throw new ErpNextError("Site already exists", 409, { exc_type: "DuplicateEntryError" });
    }) as typeof client.post;

    await expect(
      bootstrapErpNextSite(client, {
        schoolId: "00000000-0000-0000-0000-000000000001",
        slug: "duplicate-school",
        country: "US",
        currency: "USD",
        adminEmail: "admin@test.com",
      }),
    ).rejects.toThrow("Site already exists");
  });
});

describe("teardownErpNextSite", () => {
  test("returns deleted: true on success", async () => {
    const client = createMockClient();

    client.post = (async () => {
      return { data: { message: "Site deleted" }, status: 200, headers: new Headers() };
    }) as typeof client.post;

    const result = await teardownErpNextSite(client, "test-site.erpnext.studafy.com");
    expect(result.deleted).toBe(true);
  });

  test("returns deleted: true on 404 (site not found)", async () => {
    const client = createMockClient();

    client.post = (async () => {
      throw new ErpNextError("Not Found", 404, null);
    }) as typeof client.post;

    const result = await teardownErpNextSite(client, "nonexistent-site.erpnext.studafy.com");
    expect(result.deleted).toBe(true);
  });

  test("returns deleted: true on 417 (precondition failed)", async () => {
    const client = createMockClient();

    client.post = (async () => {
      throw new ErpNextError("Precondition Failed", 417, null);
    }) as typeof client.post;

    const result = await teardownErpNextSite(client, "test-site.erpnext.studafy.com");
    expect(result.deleted).toBe(true);
  });

  test("propagates non-404/417 ErpNextError", async () => {
    const client = createMockClient();

    client.post = (async () => {
      throw new ErpNextError("Internal Server Error", 500, null);
    }) as typeof client.post;

    await expect(teardownErpNextSite(client, "test-site.erpnext.studafy.com")).rejects.toThrow(
      "Internal Server Error",
    );
  });
});
