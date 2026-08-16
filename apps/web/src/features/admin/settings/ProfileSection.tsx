import { ApiError } from "@studafy/api-client";
import { Input, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useAuth } from "../../../lib/auth";
import { useUpdateUser } from "../users/mutations";
import { ROLE_LABELS } from "../users/schema";

import { myProfileQueryKey, fetchMyProfile } from "./queries";
import { fieldErrors, profileSchema } from "./schema";
import { SettingsCard } from "./SettingsCard";

import type { ProfileValues } from "./schema";
import type { Role } from "@studafy/constants";
import type { FormEvent } from "react";

const EMPTY_VALUES: ProfileValues = { display_name: "" };

/**
 * Your own display name — how you show up to other staff, students, and parents across the portal.
 * Reuses `useUpdateUser` from `admin/users/mutations` rather than a local copy: it's the same
 * `PATCH /api/users/{userId}` the users list already calls, targeted at the caller's own id
 * (decoded from the access token's `sub` claim — see `access-token-claims.ts`), and its cache patch
 * keeps the users list in sync too if this admin is also in it.
 */
export function ProfileSection() {
  const { show } = useToast();
  const { userId } = useAuth();
  const updateUser = useUpdateUser();

  const profileQuery = useQuery({
    queryKey: myProfileQueryKey(userId ?? ""),
    queryFn: () => fetchMyProfile(userId!),
    enabled: userId !== null,
  });

  const [values, setValues] = useState<ProfileValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<Partial<Record<keyof ProfileValues, string>>>({});
  // Hydrate once from the server response, then leave it alone — resyncing on every refetch would
  // clobber an in-progress edit the moment a background refetch lands.
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current && profileQuery.data) {
      setValues({ display_name: profileQuery.data.display_name ?? "" });
      hydrated.current = true;
    }
  }, [profileQuery.data]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!userId) return;

    const result = profileSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }

    updateUser.mutate(
      { userId, display_name: result.data.display_name },
      {
        onSuccess: () => show({ variant: "success", title: "Profile updated" }),
        onError: (error) => {
          show({
            variant: "error",
            title: "Couldn't save changes",
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          });
        },
      },
    );
  }

  const role = profileQuery.data?.roles[0] as Role | undefined;

  return (
    <SettingsCard
      title="Profile"
      description="How you show up to other staff, students, and parents across the portal."
      onSubmit={handleSubmit}
      saving={updateUser.isPending}
    >
      <Input
        label="Display name"
        value={values.display_name}
        onChange={(e) => {
          setValues({ display_name: e.target.value });
          setErrors({});
        }}
        helperText="Shown instead of your email wherever your name appears in the portal."
        error={errors.display_name}
        disabled={profileQuery.isPending}
        required
      />
      <Input
        label="Email"
        value={profileQuery.data?.email ?? ""}
        helperText="Your sign-in email. Changing it isn't supported from this screen."
        disabled
      />
      <Input
        label="Role"
        // eslint-disable-next-line security/detect-object-injection -- `role` is narrowed to the closed `Role` union from the API response, not user input
        value={role ? ROLE_LABELS[role] : ""}
        helperText="Assigned by another admin from the Users screen, not editable here."
        disabled
      />
    </SettingsCard>
  );
}
