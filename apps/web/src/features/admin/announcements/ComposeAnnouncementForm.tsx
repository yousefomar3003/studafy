import { ApiError } from "@studafy/api-client";
import { Button, Card, Checkbox, Input, Radio, RadioGroup, Select, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

import { useCreateAnnouncement } from "./mutations";
import { activeClassesQueryKey, fetchActiveClasses } from "./queries";
import {
  AUDIENCE_TYPE_LABEL_KEYS,
  composeAnnouncementSchema,
  EMPTY_COMPOSE_VALUES,
  fieldErrors,
  ROLE_VALUES,
  roleLabelKey,
  toCreateAnnouncementBody,
} from "./schema";

import type { Announcement } from "./queries";
import type { AnnouncementAudienceType, ComposeAnnouncementValues } from "./schema";
import type { Role } from "@studafy/constants";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

export interface ComposeAnnouncementFormProps {
  /** Fires once the announcement is created (published immediately or scheduled), so the page can
   * jump to the history tab and refresh it. */
  onCreated: (announcement: Announcement) => void;
}

const AUDIENCE_TYPES: AnnouncementAudienceType[] = ["school", "role", "class"];

/**
 * Compose/publish/schedule an announcement (ST-194). Plain `useState` + `zod.safeParse` on submit,
 * matching `users/CreateUserModal.tsx` — no react-hook-form in this codebase.
 *
 * Audience is a `RadioGroup` rather than three independent fields because exactly one shape is ever
 * valid at once (mirrors `ck_announcements_audience_shape`, migration 000105): picking "class" and
 * then switching to "school" must clear the chosen class, not just hide it, or a stale
 * `audience_class_id` could be submitted alongside `audience_type: "school"`.
 */
export function ComposeAnnouncementForm({ onCreated }: ComposeAnnouncementFormProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const createAnnouncement = useCreateAnnouncement();
  const bodyId = useId();
  const scheduleId = useId();

  const [values, setValues] = useState<ComposeAnnouncementValues>(EMPTY_COMPOSE_VALUES);
  const [errors, setErrors] = useState<Partial<Record<keyof ComposeAnnouncementValues, string>>>(
    {},
  );

  const classesQuery = useQuery({
    queryKey: activeClassesQueryKey(),
    queryFn: fetchActiveClasses,
    enabled: values.audience_type === "class",
  });
  const classOptions: SelectOption[] = (classesQuery.data ?? []).map((klass) => ({
    value: klass.id,
    label: klass.code,
  }));
  const roleOptions: SelectOption<Role>[] = ROLE_VALUES.map((role) => ({
    value: role,
    label: t(roleLabelKey(role)),
  }));

  /** Field errors hold translation keys (see `schema.ts`), resolved here at render time. */
  function errorText(key: keyof ComposeAnnouncementValues): string | undefined {
    // eslint-disable-next-line security/detect-object-injection -- `key` is a literal field name of this form's own value shape
    const message = errors[key];
    return message ? t(message) : undefined;
  }

  function setField<K extends keyof ComposeAnnouncementValues>(
    key: K,
    value: ComposeAnnouncementValues[K],
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function setAudienceType(audience_type: AnnouncementAudienceType) {
    setValues((prev) => ({
      ...prev,
      audience_type,
      audience_role: undefined,
      audience_class_id: undefined,
    }));
    setErrors((prev) => ({
      ...prev,
      audience_type: undefined,
      audience_role: undefined,
      audience_class_id: undefined,
    }));
  }

  function reset() {
    setValues(EMPTY_COMPOSE_VALUES);
    setErrors({});
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = composeAnnouncementSchema.safeParse(values);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }

    createAnnouncement.mutate(toCreateAnnouncementBody(result.data), {
      onSuccess: (announcement) => {
        show({
          variant: "success",
          title:
            announcement.status === "published"
              ? t("adminSchool.announcements.compose.published")
              : t("adminSchool.announcements.compose.scheduled"),
        });
        reset();
        onCreated(announcement);
      },
      onError: (error) => {
        show({
          variant: "error",
          title: t("adminSchool.announcements.compose.sendFailed"),
          description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
        });
      },
    });
  }

  const isScheduledForLater =
    values.scheduled_at_local !== "" &&
    !Number.isNaN(new Date(values.scheduled_at_local ?? "").getTime()) &&
    new Date(values.scheduled_at_local ?? "").getTime() > Date.now();

  return (
    <Card as="section" aria-label={t("adminSchool.announcements.compose.ariaLabel")}>
      <Card.Body>
        <form
          onSubmit={handleSubmit}
          noValidate
          aria-label={t("adminSchool.announcements.compose.ariaLabel")}
        >
          <div className="announcements-compose__fields">
            <Input
              label={t("adminSchool.announcements.compose.titleLabel")}
              value={values.title}
              onChange={(e) => setField("title", e.target.value)}
              error={errorText("title")}
              required
              autoFocus
            />

            <div className="sf-field">
              <label className="sf-field__label" htmlFor={bodyId}>
                {t("adminSchool.announcements.compose.messageLabel")}
                <span className="sf-field__required" aria-hidden="true">
                  *
                </span>
              </label>
              <div className="sf-input announcements-compose__body-input">
                <textarea
                  id={bodyId}
                  className="sf-input__control"
                  rows={6}
                  maxLength={5000}
                  value={values.body}
                  onChange={(e) => setField("body", e.target.value)}
                  aria-invalid={errors.body ? true : undefined}
                  required
                />
              </div>
              {errors.body ? (
                <p className="sf-field__error" role="alert">
                  {errorText("body")}
                </p>
              ) : null}
            </div>

            <Checkbox
              label={t("adminSchool.announcements.compose.mandatory")}
              checked={values.mandatory}
              onChange={(e) => setField("mandatory", e.target.checked)}
            />

            <RadioGroup
              label={t("adminSchool.announcements.compose.audienceLabel")}
              name="audience_type"
              value={values.audience_type}
              onChange={(value) => setAudienceType(value as AnnouncementAudienceType)}
              error={errorText("audience_type")}
            >
              {AUDIENCE_TYPES.map((type) => (
                <Radio
                  key={type}
                  value={type}
                  // eslint-disable-next-line security/detect-object-injection -- `type` comes from iterating this module's own fixed `AUDIENCE_TYPES` list, not user input
                  label={t(AUDIENCE_TYPE_LABEL_KEYS[type])}
                />
              ))}
            </RadioGroup>

            {values.audience_type === "role" ? (
              <Select
                label={t("adminSchool.announcements.compose.roleLabel")}
                options={roleOptions}
                value={values.audience_role}
                onChange={(value) => setField("audience_role", value)}
                error={errorText("audience_role")}
                required
              />
            ) : null}

            {values.audience_type === "class" ? (
              <Select
                label={t("adminSchool.announcements.compose.classLabel")}
                options={classOptions}
                value={values.audience_class_id}
                onChange={(value) => setField("audience_class_id", value)}
                error={errorText("audience_class_id")}
                placeholder={
                  classesQuery.isPending
                    ? t("adminSchool.announcements.compose.loadingClasses")
                    : t("adminSchool.announcements.compose.selectClass")
                }
                disabled={classesQuery.isPending}
                required
              />
            ) : null}

            <div className="sf-field">
              <label className="sf-field__label" htmlFor={scheduleId}>
                {t("adminSchool.announcements.compose.publishAtLabel")}
              </label>
              <div className="sf-input">
                <input
                  id={scheduleId}
                  type="datetime-local"
                  className="sf-input__control"
                  value={values.scheduled_at_local}
                  onChange={(e) => setField("scheduled_at_local", e.target.value)}
                  aria-invalid={errors.scheduled_at_local ? true : undefined}
                />
              </div>
              <p className="sf-field__helper">
                {t("adminSchool.announcements.compose.publishAtHelp")}
              </p>
              {errors.scheduled_at_local ? (
                <p className="sf-field__error" role="alert">
                  {errorText("scheduled_at_local")}
                </p>
              ) : null}
            </div>
          </div>

          <div className="announcements-compose__actions">
            <Button type="submit" loading={createAnnouncement.isPending}>
              {isScheduledForLater
                ? t("adminSchool.announcements.compose.schedule")
                : t("adminSchool.announcements.compose.publishNow")}
            </Button>
          </div>
        </form>
      </Card.Body>
    </Card>
  );
}
