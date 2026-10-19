import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../../lib/api";

import type { MemberRole } from "./queries";

export interface NewMemberValues {
  role: MemberRole;
  /** Teacher, parent and attendance officer. */
  displayName: string;
  /** Student. */
  firstName: string;
  lastName: string;
  admissionNumber: string;
  /** Teacher. */
  employeeNumber: string;
  /** Optional for everyone: members sign in with their ID and a password. */
  email: string;
}

export interface CreatedMember {
  userId: string;
  usernames: string[];
}

function invalidateMembers(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["users"] });
}

/**
 * Creates the account through the endpoint that owns its records: a student gets a student profile
 * (admission number), a teacher a teacher profile (employee number); parents and attendance officers
 * are plain accounts. The member ID is issued by the database as the role is granted, so it is read
 * back from the user afterwards.
 */
export function useCreateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: NewMemberValues): Promise<CreatedMember> => {
      const email = values.email.trim() || undefined;
      let userId: string;
      if (values.role === "STUDENT") {
        const { data } = await api.POST("/api/students", {
          body: {
            first_name: values.firstName.trim(),
            last_name: values.lastName.trim(),
            admission_number: values.admissionNumber.trim(),
            // Added by the school to sign in straight away, so already enrolled.
            status: "enrolled",
            email,
          },
        });
        userId = data!.user_id;
      } else if (values.role === "INSTRUCTOR") {
        const { data } = await api.POST("/api/teachers", {
          body: {
            display_name: values.displayName.trim(),
            employee_number: values.employeeNumber.trim(),
            employment_status: "active",
            email,
          },
        });
        userId = data!.user_id;
      } else {
        const { data } = await api.POST("/api/users", {
          body: { display_name: values.displayName.trim(), role: values.role, email },
        });
        // Same generated readonly-array typing gap as `admin/users/queries.ts`.
        return { userId: data!.id, usernames: data!.member_codes as unknown as string[] };
      }
      const { data: user } = await api.GET("/api/users/{userId}", {
        params: { path: { userId } },
      });
      return { userId, usernames: (user?.member_codes ?? []) as unknown as string[] };
    },
    onSettled: () => invalidateMembers(queryClient),
  });
}

export function useResetMemberPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const { data } = await api.POST("/api/users/{userId}/password/reset", {
        params: { path: { userId } },
      });
      return {
        usernames: data!.usernames as unknown as string[],
        default_password: data!.default_password,
      };
    },
    onSettled: () => invalidateMembers(queryClient),
  });
}
