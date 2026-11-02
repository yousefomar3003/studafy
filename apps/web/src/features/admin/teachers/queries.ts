import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";
import { fetchAllCursorPages } from "../timetable/queries";

import type { components } from "@studafy/api-client";

export type TeacherProfile = components["schemas"]["TeacherProfile"];
export type EmploymentStatus = TeacherProfile["employment_status"];
export type UpdateTeacherInput = components["schemas"]["UpdateTeacherBody"];

export interface TeacherRow extends TeacherProfile {
  display_name: string;
  email: string | null;
}

export const TEACHERS_KEY = ["admin", "teachers"] as const;

/** Every teacher profile joined to its user account's name: a profile carries only the employee
 * number, the name lives on the user (the same join `fetchTeacherContacts` does for the timetable). */
async function fetchTeacherRows(): Promise<TeacherRow[]> {
  const [teachers, users] = await Promise.all([
    fetchAllCursorPages<TeacherProfile>(async (limit, cursor) => {
      const { data } = await api.GET("/api/teachers", { params: { query: { limit, cursor } } });
      return {
        rows: (data?.teachers ?? []) as TeacherProfile[],
        nextCursor: data?.next_cursor ?? null,
      };
    }),
    fetchAllCursorPages<components["schemas"]["UserListItem"]>(async (limit, cursor) => {
      const { data } = await api.GET("/api/users", {
        params: { query: { role: "INSTRUCTOR", limit, cursor } },
      });
      return {
        rows: (data?.users ?? []) as components["schemas"]["UserListItem"][],
        nextCursor: data?.next_cursor ?? null,
      };
    }),
  ]);
  const userById = new Map(users.map((user) => [user.id, user]));
  return teachers
    .map((teacher) => {
      const user = userById.get(teacher.user_id);
      return {
        ...teacher,
        display_name: user?.display_name ?? user?.email ?? teacher.employee_number,
        email: user?.email ?? null,
      };
    })
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export function useTeacherRows() {
  return useQuery({ queryKey: TEACHERS_KEY, queryFn: fetchTeacherRows });
}

export function useUpdateTeacher() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ teacherId, body }: { teacherId: string; body: UpdateTeacherInput }) => {
      const { data } = await api.PATCH("/api/teachers/{teacherId}", {
        params: { path: { teacherId } },
        body,
      });
      if (!data) throw new Error("Teacher update returned no data.");
      return data as TeacherProfile;
    },
    // The timetable's teacher picker reads the same profiles.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: TEACHERS_KEY }),
        queryClient.invalidateQueries({ queryKey: ["timetable"] }),
      ]),
  });
}
