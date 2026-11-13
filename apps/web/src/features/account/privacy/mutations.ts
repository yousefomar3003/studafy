import { useMutation } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type AccountDeletion = components["schemas"]["AccountDeletion"];

/**
 * Deletes the caller's own account (`POST /api/account/deletion`). The server signs the caller out
 * everywhere as part of this, so nothing is invalidated on success: the response is the last thing
 * this session can read, and the page shows it before signing out locally.
 */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/account/deletion", {});
      // Nested arrays lose their array type through the generated client (the gap queries.ts
      // documents), so the schema type is asserted explicitly.
      return data as AccountDeletion | undefined;
    },
  });
}
