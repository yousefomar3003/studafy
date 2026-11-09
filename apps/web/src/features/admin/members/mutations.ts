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
  /** Null when the account was created but issuing its first code failed; reset to retry. */
  setup: SetupCode | null;
}

/** A one-time setup code (QA-11). Returned once by the API; nothing can show it again. */
export interface SetupCode {
  setupCode: string;
  expiresAt: string;
}

export interface IssuedMember extends SetupCode {
  usernames: string[];
}

/** Issues a member a new setup code, removing their password (the admin "reset password"). */
async function issueSetupCode(userId: string): Promise<IssuedMember> {
  const { data } = await api.POST("/api/users/{userId}/password/reset", {
    params: { path: { userId } },
  });
  return {
    usernames: data!.usernames as unknown as string[],
    setupCode: data!.setup_code,
    expiresAt: data!.expires_at,
  };
}

function invalidateMembers(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["users"] });
}

/**
 * Creates the account through the endpoint that owns its records: a student gets a student profile
 * (admission number), a teacher a teacher profile (employee number); parents and attendance officers
 * are plain accounts. The member ID is issued by the database as the role is granted, so it is read
 * back from the user afterwards. Then the member's first setup code is issued, for the admin to hand
 * over.
 */
export function useCreateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (values: NewMemberValues): Promise<CreatedMember> => {
      const created = await createAccount(values);
      // The account exists either way; a failed code is recovered with "Reset password".
      const setup = await issueSetupCode(created.userId).then(
        ({ setupCode, expiresAt }) => ({ setupCode, expiresAt }),
        () => null,
      );
      return { ...created, setup };
    },
    onSettled: () => invalidateMembers(queryClient),
  });
}

async function createAccount(values: NewMemberValues): Promise<Omit<CreatedMember, "setup">> {
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
}

export function useResetMemberPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: issueSetupCode,
    onSettled: () => invalidateMembers(queryClient),
  });
}

export interface BulkIssuedMember extends IssuedMember {
  displayName: string | null;
}

/** Safety stop: 40 batches of 500 is far beyond any school's roster. */
const MAX_BULK_BATCHES = 40;

/**
 * Issues setup codes to every member of `role` who cannot sign in yet, batch by batch until none
 * remain. Members who already have a password or a live code are skipped by the API.
 */
export function useIssueUnclaimedSetupCodes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (role: MemberRole): Promise<BulkIssuedMember[]> => {
      const issued: BulkIssuedMember[] = [];
      for (let batch = 0; batch < MAX_BULK_BATCHES; batch += 1) {
        const { data } = await api.POST("/api/users/member-setup-codes", { body: { role } });
        // Same generated readonly-array typing gap as `admin/users/queries.ts`.
        const rows = data!.issued as unknown as NonNullable<typeof data>["issued"][number][];
        for (const row of rows) {
          issued.push({
            displayName: row.display_name,
            usernames: row.usernames as unknown as string[],
            setupCode: row.setup_code,
            expiresAt: row.expires_at,
          });
        }
        if (data!.remaining === 0 || rows.length === 0) break;
      }
      return issued;
    },
    onSettled: () => invalidateMembers(queryClient),
  });
}
