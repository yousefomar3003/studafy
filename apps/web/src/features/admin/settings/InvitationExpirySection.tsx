import { ApiError } from "@studafy/api-client";
import { Input, useToast } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

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
  const { t } = useTranslation();
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
      onSuccess: () =>
        show({ variant: "success", title: t("adminSchool.settings.invitationExpiry.updated") }),
      onError: (error) => {
        show({
          variant: "error",
          title: t("adminSchool.settings.saveFailed"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  return (
    <SettingsCard
      title={t("adminSchool.settings.invitationExpiry.title")}
      description={t("adminSchool.settings.invitationExpiry.description")}
      onSubmit={handleSubmit}
      saving={updateSettings.isPending}
    >
      <Input
        label={t("adminSchool.settings.invitationExpiry.label")}
        type="number"
        min={1}
        max={365}
        value={values.invitation_expiry_days}
        onChange={(e) => {
          setValues({ invitation_expiry_days: Number(e.target.value) });
          setErrors({});
        }}
        helperText={t("adminSchool.settings.invitationExpiry.help")}
        error={errors.invitation_expiry_days ? t(errors.invitation_expiry_days) : undefined}
        disabled={loading}
        required
      />
    </SettingsCard>
  );
}
