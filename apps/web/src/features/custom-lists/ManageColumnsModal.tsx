import { Button, Chip, Modal, useToast } from "@studafy/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";

import { columnLabel } from "./cells";
import {
  ColumnForm,
  EMPTY_COLUMN,
  columnBody,
  isChoice,
  optionsText,
  parseOptions,
} from "./ColumnForm";
import { errorDetail } from "./CustomListsPage";
import { customListsKey } from "./queries";

import type { ColumnDraft } from "./ColumnForm";
import type { CustomListColumn, CustomListDetail } from "./queries";

export interface ManageColumnsModalProps {
  list: CustomListDetail;
  open: boolean;
  onClose: () => void;
}

function draftOf(column: CustomListColumn): ColumnDraft {
  return {
    label_en: column.label_en,
    label_ar: column.label_ar,
    field_type: column.field_type,
    required: column.required,
    sensitive: column.sensitivity === "sensitive",
    options: optionsText(column.options),
  };
}

/**
 * A list's columns (`customList:manage`): add one, relabel it, change its choices or whether it is
 * required, move it up or down, archive or restore it. Type and sensitivity are fixed once a column
 * exists; archiving hides a column and keeps its values.
 */
export function ManageColumnsModal({ list, open, onClose }: ManageColumnsModalProps) {
  const { t, i18n } = useTranslation();
  const { show } = useToast();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState<ColumnDraft | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: ColumnDraft } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: customListsKey });
    },
    onError: (caught) => setError(errorDetail(caught) ?? t("customLists.columns.saveError")),
  });
  const path = { listId: list.id };

  function addColumn() {
    const body = adding && columnBody(adding);
    if (!body) {
      setError(t("customLists.column.incomplete"));
      return;
    }
    run.mutate(() => api.POST("/api/custom-lists/{listId}/columns", { params: { path }, body }), {
      onSuccess: () => {
        setAdding(null);
        show({ variant: "success", title: t("customLists.columns.added") });
      },
    });
  }

  function saveEdit(column: CustomListColumn) {
    if (!editing) return;
    const { draft } = editing;
    if (!draft.label_en.trim()) {
      setError(t("customLists.column.incomplete"));
      return;
    }
    run.mutate(
      () =>
        api.PATCH("/api/custom-lists/{listId}/columns/{columnId}", {
          params: { path: { ...path, columnId: column.id } },
          body: {
            label_en: draft.label_en.trim(),
            label_ar: draft.label_ar.trim() || draft.label_en.trim(),
            required: draft.required,
            ...(isChoice(column.field_type) ? { options: parseOptions(draft.options) } : {}),
          },
        }),
      { onSuccess: () => setEditing(null) },
    );
  }

  function setArchived(column: CustomListColumn, archived: boolean) {
    run.mutate(() =>
      api.PATCH("/api/custom-lists/{listId}/columns/{columnId}", {
        params: { path: { ...path, columnId: column.id } },
        body: { archived },
      }),
    );
  }

  function move(index: number, by: -1 | 1) {
    const ids = list.columns.map((column) => column.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    const [moved] = ids.splice(index, 1);
    ids.splice(target, 0, moved!);
    run.mutate(() =>
      api.PUT("/api/custom-lists/{listId}/column-order", {
        params: { path },
        body: { column_ids: ids },
      }),
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={t("customLists.columns.title")}>
      <Modal.Body>
        {list.columns.length === 0 ? <p>{t("customLists.columns.none")}</p> : null}
        <ol className="custom-lists__columns">
          {list.columns.map((column, index) => {
            const label = columnLabel(column, i18n.language);
            return (
              <li key={column.id}>
                <div className="custom-lists__column-line">
                  <span>
                    <strong>{label}</strong> · {t(`customLists.types.${column.field_type}`)}
                    {column.sensitivity === "sensitive" ? (
                      <>
                        {" "}
                        <Chip>{t("customLists.common.sensitive")}</Chip>
                      </>
                    ) : null}
                    {column.archived ? (
                      <>
                        {" "}
                        <Chip>{t("customLists.common.archived")}</Chip>
                      </>
                    ) : null}
                  </span>
                  <span className="custom-lists__row-actions">
                    <Button
                      type="button"
                      variant="tertiary"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={t("customLists.columns.moveUp", { column: label })}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary"
                      disabled={index === list.columns.length - 1}
                      onClick={() => move(index, 1)}
                      aria-label={t("customLists.columns.moveDown", { column: label })}
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary"
                      onClick={() => setEditing({ id: column.id, draft: draftOf(column) })}
                    >
                      {t("customLists.columns.edit")}
                    </Button>
                    <Button
                      type="button"
                      variant="tertiary"
                      onClick={() => setArchived(column, !column.archived)}
                    >
                      {t(
                        column.archived
                          ? "customLists.columns.restore"
                          : "customLists.columns.archive",
                      )}
                    </Button>
                  </span>
                </div>
                {editing?.id === column.id ? (
                  <div className="custom-lists__inline-form">
                    <ColumnForm
                      draft={editing.draft}
                      onChange={(draft) => setEditing({ id: column.id, draft })}
                      locked
                    />
                    <Button type="button" onClick={() => saveEdit(column)} loading={run.isPending}>
                      {t("customLists.columns.save")}
                    </Button>
                    <Button type="button" variant="tertiary" onClick={() => setEditing(null)}>
                      {t("customLists.common.cancel")}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>

        {adding ? (
          <div className="custom-lists__inline-form">
            <ColumnForm draft={adding} onChange={setAdding} />
            <Button type="button" onClick={addColumn} loading={run.isPending}>
              {t("customLists.columns.addSubmit")}
            </Button>
            <Button type="button" variant="tertiary" onClick={() => setAdding(null)}>
              {t("customLists.common.cancel")}
            </Button>
          </div>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setAdding(EMPTY_COLUMN)}>
            {t("customLists.columns.add")}
          </Button>
        )}

        {error ? (
          <p role="alert" className="custom-lists__error">
            {error}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("customLists.common.close")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
