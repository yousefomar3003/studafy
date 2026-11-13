import { ApiError } from "@studafy/api-client";
import { PERMISSIONS } from "@studafy/constants";
import { Button, Checkbox, Chip, Input, Modal, Select, useToast } from "@studafy/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { LinkButton } from "../../components/LinkButton";
import { api } from "../../lib/api";
import { useAuth, usePermissions } from "../../lib/auth";
import { useTranslation } from "../../lib/i18n";

import { listName } from "./cells";
import { ColumnForm, EMPTY_COLUMN, columnBody } from "./ColumnForm";
import {
  LINK_KINDS,
  LISTS_PATH,
  audiencesFor,
  customListsKey,
  customListsQueryKey,
  fetchCustomLists,
  listHref,
} from "./queries";

import "./custom-lists.css";

import type { ColumnDraft } from "./ColumnForm";
import type { CustomListAudience, CustomListLinks } from "./queries";
import type { FormEvent } from "react";

export function errorDetail(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * The Lists area (`/portal/lists`, `customList:use`): every custom list the caller's audience
 * reaches -- the API leaves out the rest -- with its row count. Leadership (`customList:manage`)
 * also creates lists here, by hand or from a spreadsheet.
 */
export default function CustomListsPage() {
  const { t, i18n } = useTranslation();
  const permissions = usePermissions();
  const canManage = permissions.has(PERMISSIONS.CUSTOM_LIST_MANAGE);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: customListsQueryKey(includeArchived),
    queryFn: () => fetchCustomLists(includeArchived),
  });

  return (
    <>
      <div className="custom-lists__header">
        <div>
          <h1>{t("customLists.index.title")}</h1>
          <p className="custom-lists__intro">{t("customLists.index.intro")}</p>
        </div>
        {canManage ? (
          <div className="custom-lists__actions">
            <LinkButton href={`${LISTS_PATH}/import`} variant="secondary">
              {t("customLists.index.fromSheet")}
            </LinkButton>
            <Button onClick={() => setCreating(true)}>{t("customLists.index.create")}</Button>
          </div>
        ) : null}
      </div>

      <Checkbox
        label={t("customLists.index.showArchived")}
        checked={includeArchived}
        onChange={(event) => setIncludeArchived(event.target.checked)}
      />

      {query.isPending ? (
        <p role="status">{t("customLists.common.loading")}</p>
      ) : query.isError ? (
        <p role="alert">{t("customLists.index.loadError")}</p>
      ) : query.data.lists.length === 0 ? (
        <p>{t(canManage ? "customLists.index.emptyManager" : "customLists.index.empty")}</p>
      ) : (
        <table className="custom-lists__table">
          <caption className="custom-lists__visually-hidden">
            {t("customLists.index.title")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("customLists.index.columns.name")}</th>
              <th scope="col">{t("customLists.index.columns.audience")}</th>
              <th scope="col">{t("customLists.index.columns.rows")}</th>
            </tr>
          </thead>
          <tbody>
            {query.data.lists.map((list) => (
              <tr key={list.id}>
                <td>
                  <Link to={listHref(list.id)}>{listName(list, i18n.language)}</Link>
                  {list.archived ? (
                    <>
                      {" "}
                      <Chip>{t("customLists.common.archived")}</Chip>
                    </>
                  ) : null}
                </td>
                <td>{t(`customLists.audience.${list.audience}`)}</td>
                <td>{t("customLists.index.rowCount", { count: list.row_count })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canManage ? <NewListModal open={creating} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

interface NewListModalProps {
  open: boolean;
  onClose: () => void;
}

const NO_LINKS: CustomListLinks = { student: false, parent: false, staff: false, class: false };

function NewListModal({ open, onClose }: NewListModalProps) {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const { show } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const descriptionId = useId();
  const audiences = audiencesFor(roles);
  const [nameEn, setNameEn] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [description, setDescription] = useState("");
  const [audience, setAudience] = useState<CustomListAudience>(audiences[0]!);
  const [links, setLinks] = useState<CustomListLinks>(NO_LINKS);
  const [columns, setColumns] = useState<ColumnDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/custom-lists", {
        body: {
          name_en: nameEn.trim(),
          name_ar: nameAr.trim(),
          description: description.trim() || null,
          audience,
          links,
          columns: columns.map(columnBody).filter((column) => column !== null),
        },
      });
      return data;
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: customListsKey });
      show({ variant: "success", title: t("customLists.index.created") });
      onClose();
      if (data) navigate(listHref(data.id));
    },
    onError: (caught) => setError(errorDetail(caught) ?? t("customLists.index.createError")),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!nameEn.trim() || !nameAr.trim()) {
      setError(t("customLists.index.namesRequired"));
      return;
    }
    if (columns.some((column) => columnBody(column) === null)) {
      setError(t("customLists.column.incomplete"));
      return;
    }
    setError(null);
    create.mutate();
  }

  return (
    <Modal open={open} onClose={onClose} title={t("customLists.index.create")}>
      <form onSubmit={submit} noValidate aria-label={t("customLists.index.create")}>
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
            options={audiences.map((value) => ({
              value,
              label: t(`customLists.audience.${value}`),
            }))}
            value={audience}
            onChange={(value) => setAudience(value as CustomListAudience)}
            helperText={t("customLists.settings.audienceHelp")}
          />
          <LinkKindsField links={links} onChange={setLinks} />

          <fieldset className="custom-lists__fieldset">
            <legend>{t("customLists.index.firstColumns")}</legend>
            {columns.map((column, index) => (
              <div key={index} className="custom-lists__draft-column">
                <ColumnForm
                  draft={column}
                  onChange={(next) =>
                    setColumns(columns.map((item, at) => (at === index ? next : item)))
                  }
                />
                <Button
                  type="button"
                  variant="tertiary"
                  onClick={() => setColumns(columns.filter((_, at) => at !== index))}
                >
                  {t("customLists.index.removeColumn")}
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              onClick={() => setColumns([...columns, EMPTY_COLUMN])}
            >
              {t("customLists.index.addColumn")}
            </Button>
          </fieldset>

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
          <Button type="submit" loading={create.isPending}>
            {t("customLists.index.createSubmit")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

export function LinkKindsField({
  links,
  onChange,
}: {
  links: CustomListLinks;
  onChange: (links: CustomListLinks) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="custom-lists__fieldset">
      <legend>{t("customLists.settings.links")}</legend>
      {LINK_KINDS.map((kind) => (
        <Checkbox
          key={kind}
          label={t(`customLists.linkKinds.${kind}`)}
          // eslint-disable-next-line security/detect-object-injection -- `kind` comes from the fixed LINK_KINDS list
          checked={links[kind]}
          onChange={(event) => onChange({ ...links, [kind]: event.target.checked })}
        />
      ))}
    </fieldset>
  );
}
