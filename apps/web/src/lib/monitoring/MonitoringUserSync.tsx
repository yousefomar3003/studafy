import { useSyncMonitoringUser } from "./use-sync-monitoring-user";

/** Renders nothing; exists only to mount `useSyncMonitoringUser` inside `AuthProvider`. */
export function MonitoringUserSync(): null {
  useSyncMonitoringUser();
  return null;
}
