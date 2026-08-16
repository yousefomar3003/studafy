import { ApiError } from "@studafy/api-client";
import { Input, useToast } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";

import { useUpdateSchoolSettings } from "./mutations";
import { fieldErrors, invitationExpirySchema } from "./schema";
import { SettingsCard } from "./SettingsCard";

import type { SchoolSettings } from "./queries";
import type { InvitationExpiryValues } from "./schema";
import type { FormEvent } from "react";

export interface InvitationExpirySectionProps {
  settings: SchoolSettings | undefined;
  loading: boolean;
}

/** How long a new invitation link stays valid. Only applies going forward — see the helper text —
 * so no confirm: nothing already sent is affected. */
export function InvitationExpirySection({ settings, loading }: InvitationExpirySectionProps) {
  const { show } = useToast();
  const updateSettings = useUpdateSchoolSettings();

  const [values, setValues] = useState<InvitationExpiryValues>({ invitation_expiry_days: 7 });
  const [errors, setErrors] = useState<Partial<Record<keyof InvitationExpiryValues, string>>>({});
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current && settings) {
      setValues({ invitation_expiry_days: settings.invitation_expiry_days });
      hydrated.current = true;
    }
  }, [settings]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const result = invitationExpirySchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }

    updateSettings.mutate(result.data, {
      onSuccess: () => show({ variant: "success", title: "Invitation expiry updated" }),
      onError: (error) => {
        show({
          variant: "error",
          title: "Couldn't save changes",
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  return (
    <SettingsCard
      title="Invitation expiry"
      description="How long a new invitation link stays valid before it expires."
      onSubmit={handleSubmit}
      saving={updateSettings.isPending}
    >
      <Input
        label="Expires after (days)"
        type="number"
        min={1}
        max={365}
        value={values.invitation_expiry_days}
        onChange={(e) => {
          setValues({ invitation_expiry_days: Number(e.target.value) });
          setErrors({});
        }}
        helperText="Applies to invitations sent after this change — already-sent links keep their original expiry."
        error={errors.invitation_expiry_days}
        disabled={loading}
        required
      />
    </SettingsCard>
  );
}
