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
 * What parents can do from the mobile app: whether a linked parent may put their child's own account
 * on their phone with one tap ("Add <child> to this phone", 000217), and whether parents and teachers
 * may send voice notes in chats (000218). Saves directly: turning either off only stops new ones
 * (accounts already added stay, notes already sent stay playable), so there is nothing for a
 * confirmation to warn about.
 */
export function ParentAppSection({ settings, loading }: ParentAppSectionProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const updateSettings = useUpdateSchoolSettings();
  const [allowDeviceSignin, setAllowDeviceSignin] = useState(true);
  const [allowVoiceNotes, setAllowVoiceNotes] = useState(true);
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current && settings) {
      setAllowDeviceSignin(settings.allow_parent_device_signin);
      setAllowVoiceNotes(settings.allow_voice_notes);
      hydrated.current = true;
    }
  }, [settings]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateSettings.mutate(
      { allow_parent_device_signin: allowDeviceSignin, allow_voice_notes: allowVoiceNotes },
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
      <Checkbox
        checked={allowVoiceNotes}
        onChange={(e) => setAllowVoiceNotes(e.target.checked)}
        label={t("adminSchool.settings.parentApp.voiceNotes")}
        disabled={loading}
      />
      <p className="settings-card__description">
        {t("adminSchool.settings.parentApp.voiceNotesHelp")}
      </p>
    </SettingsCard>
  );
}
