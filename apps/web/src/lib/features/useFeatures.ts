import { useQuery } from "@tanstack/react-query";

import { api } from "../api";

import { featureGateState } from "./gate";

import type { FeatureGateState, FeatureKey, MyFeatures } from "./gate";
import type { UseQueryResult } from "@tanstack/react-query";

/**
 * Query key of `GET /api/me/features`. The realtime layer invalidates it on
 * `userEntitlement.changed` (and on every reconnect) -- see lib/realtime/invalidations.ts.
 */
export const MY_FEATURES_QUERY_KEY = ["me", "features"] as const;

/**
 * The signed-in person's paid features, refreshed when the window regains focus (a purchase or a
 * seat may have happened in another tab or app) and when the server says their entitlements
 * changed.
 */
export function useFeatures(): UseQueryResult<MyFeatures> {
  return useQuery({
    queryKey: MY_FEATURES_QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.GET("/api/me/features");
      if (!data) throw new Error("Features returned no data.");
      return data as MyFeatures;
    },
    refetchOnWindowFocus: true,
  });
}

/** One feature's gate, or null while the features load (or could not). */
export function useFeatureGate(key: FeatureKey): FeatureGateState | null {
  const features = useFeatures();
  return features.data ? featureGateState(features.data, key) : null;
}
