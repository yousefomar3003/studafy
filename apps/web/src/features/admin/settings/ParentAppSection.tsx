import { ApiError } from "@studafy/api-client";
import { Checkbox, useToast } from "@studafy/ui";
import { useEffect, useRef, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useUpdateSchoolSettings } from "./mutations";
import { SettingsCard } from "./SettingsCard";

import type { SchoolSettings } from "./queries";
import type { FormEvent } from "react";

export interface ParentAppSectionProps {
  settings: SchoolSettings | undefined;
  loading: boolean;
}

/**
 * What parents can do from the mobile app: today, whether a linked parent may put their child's own
 * account on their phone with one tap ("Add <child> to this phone", 000217). Saves directly: turning
 * it off only stops new ones, so there is nothing for a confirmation to warn about.
 */
export function ParentAppSection({ settings, loading }: ParentAppSectionProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const updateSettings = useUpdateSchoolSettings();
  const [allowDeviceSignin, setAllowDeviceSignin] = useState(true);
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current && settings) {
      setAllowDeviceSignin(settings.allow_parent_device_signin);
      hydrated.current = true;
    }
  }, [settings]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateSettings.mutate(
      { allow_parent_device_signin: allowDeviceSignin },
      {
        onSuccess: () =>
          show({ variant: "success", title: t("adminSchool.settings.parentApp.updated") }),
        onError: (error) =>
          show({
            variant: "error",
            title: t("adminSchool.settings.saveFailed"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <SettingsCard
      title={t("adminSchool.settings.parentApp.title")}
      description={t("adminSchool.settings.parentApp.description")}
      onSubmit={handleSubmit}
      saving={updateSettings.isPending}
    >
      <Checkbox
        checked={allowDeviceSignin}
        onChange={(e) => setAllowDeviceSignin(e.target.checked)}
        label={t("adminSchool.settings.parentApp.deviceSignin")}
        disabled={loading}
      />
      <p className="settings-card__description">
        {t("adminSchool.settings.parentApp.deviceSigninHelp")}
      </p>
    </SettingsCard>
  );
}
