import { ApiError } from "@studafy/api-client";
import { Button, Card, Checkbox, Input, Radio, RadioGroup, Select, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { useCreateAnnouncement } from "./mutations";
import { activeClassesQueryKey, fetchActiveClasses } from "./queries";
import {
  AUDIENCE_TYPE_LABELS,
  composeAnnouncementSchema,
  EMPTY_COMPOSE_VALUES,
  fieldErrors,
  ROLE_OPTIONS,
  toCreateAnnouncementBody,
} from "./schema";

import type { Announcement } from "./queries";
import type { AnnouncementAudienceType, ComposeAnnouncementValues } from "./schema";
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
              ? "Announcement published"
              : "Announcement scheduled",
        });
        reset();
        onCreated(announcement);
      },
      onError: (error) => {
        show({
          variant: "error",
          title: "Couldn't send announcement",
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
    <Card as="section" aria-label="Compose announcement">
      <Card.Body>
        <form onSubmit={handleSubmit} noValidate aria-label="Compose announcement">
          <div className="announcements-compose__fields">
            <Input
              label="Title"
              value={values.title}
              onChange={(e) => setField("title", e.target.value)}
              error={errors.title}
              required
              autoFocus
            />

            <div className="sf-field">
              <label className="sf-field__label" htmlFor={bodyId}>
                Message
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
                  {errors.body}
                </p>
              ) : null}
            </div>

            <Checkbox
              label="Mandatory — recipients cannot disable this notice"
              checked={values.mandatory}
              onChange={(e) => setField("mandatory", e.target.checked)}
            />

            <RadioGroup
              label="Audience"
              name="audience_type"
              value={values.audience_type}
              onChange={(value) => setAudienceType(value as AnnouncementAudienceType)}
              error={errors.audience_type}
            >
              {AUDIENCE_TYPES.map((type) => (
                <Radio key={type} value={type} label={AUDIENCE_TYPE_LABELS[type]} />
              ))}
            </RadioGroup>

            {values.audience_type === "role" ? (
              <Select
                label="Role"
                options={ROLE_OPTIONS}
                value={values.audience_role}
                onChange={(value) => setField("audience_role", value)}
                error={errors.audience_role}
                required
              />
            ) : null}

            {values.audience_type === "class" ? (
              <Select
                label="Class"
                options={classOptions}
                value={values.audience_class_id}
                onChange={(value) => setField("audience_class_id", value)}
                error={errors.audience_class_id}
                placeholder={classesQuery.isPending ? "Loading classes…" : "Select a class"}
                disabled={classesQuery.isPending}
                required
              />
            ) : null}

            <div className="sf-field">
              <label className="sf-field__label" htmlFor={scheduleId}>
                Publish at
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
                Leave blank to publish immediately. Uses your device&rsquo;s local time zone —
                converted to a fixed instant, so recipients see it at the same moment everywhere.
              </p>
              {errors.scheduled_at_local ? (
                <p className="sf-field__error" role="alert">
                  {errors.scheduled_at_local}
                </p>
              ) : null}
            </div>
          </div>

          <div className="announcements-compose__actions">
            <Button type="submit" loading={createAnnouncement.isPending}>
              {isScheduledForLater ? "Schedule announcement" : "Publish now"}
            </Button>
          </div>
        </form>
      </Card.Body>
    </Card>
  );
}
