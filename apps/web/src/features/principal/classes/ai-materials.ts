import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { components } from "@studafy/api-client";

export type ClassAiMaterialsSetting = components["schemas"]["ClassAiMaterialsSetting"];

const KEY_ROOT = ["principal-school", "class-ai-materials"] as const;

/**
 * Whether a class's study materials are used with the AI study assistant (000196). On by default;
 * turning it off keeps them out of AI ingestion, retrieval and generation and deletes their AI
 * copies. Leadership and the class's teachers may change it.
 */
export function useClassAiMaterials(classId: string | undefined) {
  return useQuery({
    queryKey: [...KEY_ROOT, classId],
    queryFn: async (): Promise<ClassAiMaterialsSetting> => {
      const { data } = await api.GET("/api/academics/classes/{classId}/ai-materials", {
        params: { path: { classId: classId! } },
      });
      if (!data) throw new Error("Class AI materials setting returned no data.");
      return data;
    },
    enabled: classId !== undefined,
  });
}

export function useUpdateClassAiMaterials() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      classId,
      enabled,
    }: {
      classId: string;
      enabled: boolean;
    }): Promise<ClassAiMaterialsSetting> => {
      const { data } = await api.PUT("/api/academics/classes/{classId}/ai-materials", {
        params: { path: { classId } },
        body: { enabled },
      });
      if (!data) throw new Error("Class AI materials update returned no data.");
      return data;
    },
    onSuccess: (setting) => queryClient.setQueryData([...KEY_ROOT, setting.class_id], setting),
  });
}
