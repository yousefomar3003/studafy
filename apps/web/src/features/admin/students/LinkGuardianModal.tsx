import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useLinkGuardian } from "./mutations";
import { parentSearchQueryKey, searchParentUsers } from "./queries";
import { fieldErrors, linkGuardianSchema, RELATIONSHIP_LABELS } from "./schema";

import type { UserWithRoles } from "./queries";
import type { GuardianRelationship, LinkGuardianValues } from "./schema";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

const SEARCH_DEBOUNCE_MS = 300;

const RELATIONSHIP_OPTIONS: SelectOption<GuardianRelationship>[] = (
  Object.entries(RELATIONSHIP_LABELS) as [GuardianRelationship, string][]
).map(([value, label]) => ({ value, label }));

export interface LinkGuardianModalProps {
  studentId: string;
  open: boolean;
  onClose: () => void;
}

/**
 * `POST /api/students/{studentId}/guardians` — links an existing PARENT-role user as a guardian.
 * There is no combobox primitive in `@studafy/ui`, so the parent picker is a plain debounced search
 * list rather than a `Select` — `Select`'s options are a fixed, synchronous list, not a fit for
 * server-side search-as-you-type over the school's parent accounts.
 */
export function LinkGuardianModal({ studentId, open, onClose }: LinkGuardianModalProps) {
  const { show } = useToast();
  const linkGuardian = useLinkGuardian();

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedParent, setSelectedParent] = useState<UserWithRoles | null>(null);
  const [relationship, setRelationship] = useState<GuardianRelationship>("guardian");
  const [errors, setErrors] = useState<Partial<Record<keyof LinkGuardianValues, string>>>({});

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const resultsQuery = useQuery({
    queryKey: parentSearchQueryKey(debouncedSearch),
    queryFn: () => searchParentUsers(debouncedSearch),
    enabled: debouncedSearch.trim().length > 0 && selectedParent === null,
  });

  function reset() {
    setSearchInput("");
    setDebouncedSearch("");
    setSelectedParent(null);
    setRelationship("guardian");
    setErrors({});
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const result = linkGuardianSchema.safeParse({
      parent_user_id: selectedParent?.id ?? "",
      relationship,
    });
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }

    linkGuardian.mutate(
      { studentId, ...result.data },
      {
        onSuccess: () => {
          show({
            variant: "success",
            title: `Linked ${selectedParent?.display_name ?? selectedParent?.email ?? "guardian"}`,
          });
          handleClose();
        },
        onError: (error) => {
          show({
            variant: "error",
            title: "Couldn't link guardian",
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          });
        },
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Add guardian"
      description="Link an existing parent account to this student."
    >
      <form onSubmit={handleSubmit} noValidate aria-label="Add guardian">
        <Modal.Body>
          {selectedParent ? (
            <div className="students-guardian-picker__selected">
              <div>
                <strong>{selectedParent.display_name ?? selectedParent.email}</strong>
                <p>{selectedParent.email}</p>
              </div>
              <Button type="button" variant="tertiary" onClick={() => setSelectedParent(null)}>
                Change
              </Button>
            </div>
          ) : (
            <>
              <Input
                label="Search parents"
                type="search"
                placeholder="Search by name or email"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                error={errors.parent_user_id}
                autoFocus
              />
              <ul className="students-guardian-picker__results">
                {(resultsQuery.data ?? []).map((parent) => (
                  <li key={parent.id}>
                    <button
                      type="button"
                      className="students-guardian-picker__result"
                      onClick={() => setSelectedParent(parent)}
                    >
                      <strong>{parent.display_name ?? parent.email}</strong>
                      <span>{parent.email}</span>
                    </button>
                  </li>
                ))}
                {debouncedSearch.trim() &&
                !resultsQuery.isPending &&
                resultsQuery.data?.length === 0 ? (
                  <li className="students-guardian-picker__empty">No parent accounts match.</li>
                ) : null}
              </ul>
            </>
          )}

          <Select
            label="Relationship"
            options={RELATIONSHIP_OPTIONS}
            value={relationship}
            onChange={(value) => setRelationship(value)}
            required
          />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="tertiary" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" loading={linkGuardian.isPending} disabled={!selectedParent}>
            Link guardian
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
