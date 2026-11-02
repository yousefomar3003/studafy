import { Button, Checkbox, Input, Modal, Select, useToast } from "@studafy/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import { LinkKindsField, errorDetail } from "./CustomListsPage";
import { LISTS_PATH, audiencesFor, customListsKey } from "./queries";

import type { CustomListAudience, CustomListDetail, CustomListLinks } from "./queries";
import type { FormEvent } from "react";

export interface ListSettingsModalProps {
  list: CustomListDetail;
  open: boolean;
  onClose: () => void;
}

/**
 * A list's settings (`customList:manage`): names, description, audience and link kinds, archiving,
 * and deleting it with every row -- the one step that cannot be undone, so it asks again.
 */
export function ListSettingsModal({ list, open, onClose }: ListSettingsModalProps) {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const { show } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const descriptionId = useId();
  const audiences = audiencesFor(roles);
  const [nameEn, setNameEn] = useState(list.name_en);
  const [nameAr, setNameAr] = useState(list.name_ar);
  const [description, setDescription] = useState(list.description ?? "");
  const [audience, setAudience] = useState<CustomListAudience>(list.audience);
  const [links, setLinks] = useState<CustomListLinks>(list.links);
  const [archived, setArchived] = useState(list.archived);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.PATCH("/api/custom-lists/{listId}", {
        params: { path: { listId: list.id } },
        body: {
          name_en: nameEn.trim(),
          name_ar: nameAr.trim(),
          description: description.trim() || null,
          audience,
          links,
          archived,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: customListsKey });
      show({ variant: "success", title: t("customLists.settings.saved") });
      onClose();
    },
    onError: (caught) => setError(errorDetail(caught) ?? t("customLists.settings.saveError")),
  });

  const remove = useMutation({
    mutationFn: () =>
      api.DELETE("/api/custom-lists/{listId}", { params: { path: { listId: list.id } } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: customListsKey });
      show({ variant: "success", title: t("customLists.settings.deleted") });
      navigate(LISTS_PATH);
    },
    onError: (caught) => setError(errorDetail(caught) ?? t("customLists.settings.deleteError")),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!nameEn.trim() || !nameAr.trim()) {
      setError(t("customLists.index.namesRequired"));
      return;
    }
    setError(null);
    save.mutate();
  }

  // The list's current audience stays choosable even if the caller could not pick it afresh.
  const audienceOptions = audiences.includes(list.audience)
    ? audiences
    : [list.audience, ...audiences];

  return (
    <Modal open={open} onClose={onClose} title={t("customLists.settings.title")}>
      <form onSubmit={submit} noValidate aria-label={t("customLists.settings.title")}>
        <Modal.Body>
          <Input
            label={t("customLists.settings.nameEn")}
            value={nameEn}
            onChange={(event) => setNameEn(event.target.value)}
            required
          />
          <Input
            label={t("customLists.settings.nameAr")}
            value={nameAr}
            dir="rtl"
            onChange={(event) => setNameAr(event.target.value)}
            required
          />
          <div className="sf-field">
            <label className="sf-field__label" htmlFor={descriptionId}>
              {t("customLists.settings.description")}
            </label>
            <div className="sf-input custom-lists__textarea">
              <textarea
                id={descriptionId}
                className="sf-input__control"
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
          </div>
          <Select
            label={t("customLists.settings.audience")}
            options={audienceOptions.map((value) => ({
              value,
              label: t(`customLists.audience.${value}`),
            }))}
            value={audience}
            onChange={(value) => setAudience(value as CustomListAudience)}
            helperText={t("customLists.settings.audienceHelp")}
          />
          <LinkKindsField links={links} onChange={setLinks} />
          <Checkbox
            label={t("customLists.settings.archived")}
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
          />

          <section className="custom-lists__danger" aria-label={t("customLists.settings.delete")}>
            {confirmDelete ? (
              <>
                <p>{t("customLists.settings.deleteConfirmBody", { count: list.row_count })}</p>
                <Button type="button" loading={remove.isPending} onClick={() => remove.mutate()}>
                  {t("customLists.settings.deleteConfirm")}
                </Button>
                <Button type="button" variant="tertiary" onClick={() => setConfirmDelete(false)}>
                  {t("customLists.common.cancel")}
                </Button>
              </>
            ) : (
              <Button type="button" variant="tertiary" onClick={() => setConfirmDelete(true)}>
                {t("customLists.settings.delete")}
              </Button>
            )}
          </section>

          {error ? (
            <p role="alert" className="custom-lists__error">
              {error}
            </p>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={onClose}>
            {t("customLists.common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {t("customLists.settings.save")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
