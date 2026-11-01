import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import { draftFor, sameValue, valueFromDraft } from "../records/fields";
import { RecordFieldInput } from "../records/RecordFieldInput";

import { columnAsField, listName } from "./cells";
import { errorDetail } from "./CustomListsPage";
import { LINK_KINDS, customListsKey } from "./queries";

import type {
  CellValue,
  CustomListColumn,
  CustomListDetail,
  CustomListLinkKind,
  CustomListRow,
} from "./queries";
import type { RecordDraft } from "../records/fields";
import type { components } from "@studafy/api-client";
import type { FormEvent } from "react";

type LinkCandidate = components["schemas"]["CustomListLinkCandidate"];

interface ChosenLink {
  kind: CustomListLinkKind;
  id: string;
  name: string | null;
}

export interface RowModalProps {
  list: CustomListDetail;
  /** The list's active columns, in display order. */
  columns: readonly CustomListColumn[];
  /** The row to edit, or null to add one. */
  row: CustomListRow | null;
  locale: string;
  onClose: () => void;
}

/** A stored value as compared with an edit: a date is only its calendar day (first ten characters). */
function calendarValue(column: CustomListColumn, value: CellValue | null): CellValue | null {
  return column.field_type === "date" && typeof value === "string" ? value.slice(0, 10) : value;
}

/** A stored value as an input draft; a date keeps only its calendar day (first ten characters). */
function initialDraft(column: CustomListColumn, value: CellValue | null): RecordDraft {
  const draft = draftFor(columnAsField(column), value);
  return column.field_type === "date" && typeof draft === "string" ? draft.slice(0, 10) : draft;
}

/**
 * Add or edit one row: a typed input per column (the records' own field inputs) and, when the list
 * allows links, the student, parent, member of staff or class it is about. A sensitive cell is
 * never shown here: leaving its input blank keeps the stored value. Only changed cells are sent.
 */
export function RowModal({ list, columns, row, onClose }: RowModalProps) {
  const { t, i18n } = useTranslation();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const original = (column: CustomListColumn) =>
    row?.cells.find((cell) => cell.column_id === column.id) ?? null;
  const [drafts, setDrafts] = useState<Record<string, RecordDraft>>(() =>
    Object.fromEntries(
      columns.map((column) => {
        const stored = original(column);
        return [column.id, initialDraft(column, stored?.masked ? null : (stored?.value ?? null))];
      }),
    ),
  );
  const [link, setLink] = useState<ChosenLink | null>(row?.link ?? null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line security/detect-object-injection -- `kind` comes from the fixed LINK_KINDS list
  const allowedKinds = LINK_KINDS.filter((kind) => list.links[kind]);

  const save = useMutation({
    mutationFn: async () => {
      const values = columns.flatMap((column) => {
        const value = valueFromDraft(columnAsField(column), drafts[column.id] ?? null);
        const stored = original(column);
        if (stored?.masked) return value === null ? [] : [{ column_id: column.id, value }];
        if (row && sameValue(value, calendarValue(column, stored?.value ?? null))) return [];
        if (!row && value === null) return [];
        return [{ column_id: column.id, value }];
      });
      const linkBody = link ? { kind: link.kind, id: link.id } : null;
      if (row) {
        const linkChanged = (row.link?.id ?? null) !== (link?.id ?? null);
        await api.PATCH("/api/custom-lists/{listId}/rows/{rowId}", {
          params: { path: { listId: list.id, rowId: row.id } },
          body: { values, ...(linkChanged ? { link: linkBody } : {}) },
        });
      } else {
        await api.POST("/api/custom-lists/{listId}/rows", {
          params: { path: { listId: list.id } },
          body: { values, link: linkBody },
        });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: customListsKey });
      show({
        variant: "success",
        title: t(row ? "customLists.rows.saved" : "customLists.rows.added"),
      });
      onClose();
    },
    onError: (caught) => setError(errorDetail(caught) ?? t("customLists.rows.saveError")),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    save.mutate();
  }

  const title = t(row ? "customLists.rows.editTitle" : "customLists.rows.addTitle", {
    list: listName(list, i18n.language),
  });

  return (
    <Modal open onClose={onClose} title={title}>
      <form onSubmit={submit} noValidate aria-label={title}>
        <Modal.Body>
          {allowedKinds.length > 0 ? (
            <LinkPicker listId={list.id} kinds={allowedKinds} value={link} onChange={setLink} />
          ) : null}
          {columns.map((column) => {
            const stored = original(column);
            return (
              <RecordFieldInput
                key={column.id}
                field={columnAsField(column)}
                value={drafts[column.id] ?? null}
                onChange={(value) => setDrafts((current) => ({ ...current, [column.id]: value }))}
                hint={stored?.masked ? t("customLists.rows.keepSensitive") : undefined}
              />
            );
          })}
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
            {t("customLists.rows.save")}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}

/**
 * Who or what a row is about. The list's own picker endpoint offers only subjects of a kind the
 * list allows, holding the matching role (a parent PARENT, a member of staff a staff role), that the
 * caller can see; a person chooses, nothing is linked automatically.
 */
function LinkPicker({
  listId,
  kinds,
  value,
  onChange,
}: {
  listId: string;
  kinds: readonly CustomListLinkKind[];
  value: ChosenLink | null;
  onChange: (link: ChosenLink | null) => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<CustomListLinkKind>(value?.kind ?? kinds[0]!);
  const [text, setText] = useState("");
  const query = text.trim();
  const candidates = useQuery({
    queryKey: ["custom-lists", "link-candidates", listId, kind, query],
    queryFn: async () => {
      const { data } = await api.GET("/api/custom-lists/{listId}/link-candidates", {
        params: { path: { listId }, query: { kind, q: query } },
      });
      // Restated as a plain array: the generated `readonly` array loses its prototype through
      // `api.GET`'s response typing (as records/queries.ts notes).
      return (data?.candidates ?? []) as LinkCandidate[];
    },
    enabled: query.length >= 2,
  });

  if (value) {
    return (
      <fieldset className="custom-lists__fieldset">
        <legend>{t("customLists.rows.linkedTo")}</legend>
        <p>
          {t(`customLists.linkKinds.${value.kind}`)}:{" "}
          {value.name ?? t("customLists.rows.notVisible")}
        </p>
        <Button type="button" variant="tertiary" onClick={() => onChange(null)}>
          {t("customLists.rows.unlink")}
        </Button>
      </fieldset>
    );
  }

  return (
    <fieldset className="custom-lists__fieldset">
      <legend>{t("customLists.rows.linkedTo")}</legend>
      {kinds.length > 1 ? (
        <Select
          label={t("customLists.rows.linkKind")}
          options={kinds.map((option) => ({
            value: option,
            label: t(`customLists.linkKinds.${option}`),
          }))}
          value={kind}
          onChange={(next) => setKind(next as CustomListLinkKind)}
        />
      ) : null}
      <Input
        label={t("customLists.rows.findLink", { kind: t(`customLists.linkKinds.${kind}`) })}
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        autoComplete="off"
      />
      {(candidates.data ?? []).length > 0 ? (
        <ul className="custom-lists__candidates">
          {(candidates.data ?? []).map((candidate) => (
            <li key={candidate.id}>
              <Button
                type="button"
                variant="tertiary"
                onClick={() => onChange({ kind, id: candidate.id, name: candidate.name })}
              >
                {candidate.detail ? `${candidate.name} · ${candidate.detail}` : candidate.name}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}
