import { ApiError } from "@studafy/api-client";
import { Button, Card, Input, Select, useToast } from "@studafy/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { api } from "../../../lib/api";
import { useTranslation } from "../../../lib/i18n";
import {
  familySearchQueryKey,
  invalidateLinkViews,
  searchFamilies,
} from "../../admin/people-links/queries";

import type { FinanceFamilyProfile } from "./queries";
import type { components } from "@studafy/api-client";
import type { SelectOption } from "@studafy/ui";
import type { FormEvent } from "react";

type FamilyDetail = components["schemas"]["FamilyDetail"];
type FamilyLink = FamilyDetail["links"][number];

export interface ManageHouseholdPanelProps {
  family: FinanceFamilyProfile;
  /** `parent:unlink`: may remove a guardian from a child. */
  canUnlink: boolean;
}

function errorDescription(error: unknown): string | undefined {
  return error instanceof ApiError ? (error.detail ?? error.title) : undefined;
}

/**
 * Household upkeep for staff holding `parent:link` (a school admin): rename the family, choose its
 * primary guardian (the one invoices and statements address), move a child's guardian link to
 * another household, remove a link (`parent:unlink`), and delete the family once nothing is linked
 * to it. Every change goes through the families API and its audit trail; finance's balances follow
 * the links on their next read.
 */
export function ManageHouseholdPanel({ family, canUnlink }: ManageHouseholdPanelProps) {
  const { t } = useTranslation();
  const { show } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState(family.display_name);
  const primary = family.guardians.find((guardian) => guardian.is_primary)?.user_id ?? "";
  const [primaryId, setPrimaryId] = useState(primary);
  const [moving, setMoving] = useState<FamilyLink | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(handle);
  }, [search]);

  const detailKey = ["families", family.id, "detail"] as const;
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: async () => {
      const { data } = await api.GET("/api/families/{familyId}", {
        params: { path: { familyId: family.id } },
      });
      if (!data) throw new Error("Family not found.");
      return data as FamilyDetail;
    },
  });
  const targets = useQuery({
    queryKey: familySearchQueryKey(debounced),
    queryFn: () => searchFamilies(debounced),
    enabled: moving !== null && debounced.trim() !== "",
  });

  function done(title: string) {
    show({ variant: "success", title });
    invalidateLinkViews(queryClient);
    void queryClient.invalidateQueries({ queryKey: detailKey });
  }

  function failed(title: string) {
    return (error: unknown) =>
      show({ variant: "error", title, description: errorDescription(error) });
  }

  const update = useMutation({
    mutationFn: async (body: { display_name?: string; primary_parent_user_id?: string }) => {
      await api.PATCH("/api/families/{familyId}", {
        params: { path: { familyId: family.id } },
        body,
      });
    },
    onSuccess: () => done(t("finance.families.manage.savedToast")),
    onError: failed(t("finance.families.manage.saveError")),
  });

  const moveLink = useMutation({
    mutationFn: async ({ link, targetFamilyId }: { link: FamilyLink; targetFamilyId: string }) => {
      await api.PATCH("/api/families/{familyId}/links/{parentUserId}/{studentId}", {
        params: {
          path: {
            familyId: family.id,
            parentUserId: link.parent_user_id,
            studentId: link.student_id,
          },
        },
        body: { target_family_id: targetFamilyId },
      });
    },
    onSuccess: () => {
      setMoving(null);
      setSearch("");
      done(t("finance.families.manage.movedToast"));
    },
    onError: failed(t("finance.families.manage.moveError")),
  });

  const removeLink = useMutation({
    mutationFn: async (link: FamilyLink) => {
      await api.DELETE("/api/families/{familyId}/links/{parentUserId}/{studentId}", {
        params: {
          path: {
            familyId: family.id,
            parentUserId: link.parent_user_id,
            studentId: link.student_id,
          },
        },
      });
    },
    onSuccess: () => done(t("finance.families.manage.removedToast")),
    onError: failed(t("finance.families.manage.removeError")),
  });

  const deleteFamily = useMutation({
    mutationFn: async () => {
      await api.DELETE("/api/families/{familyId}", { params: { path: { familyId: family.id } } });
    },
    onSuccess: () => {
      show({ variant: "success", title: t("finance.families.manage.deletedToast") });
      invalidateLinkViews(queryClient);
      navigate("/portal/finance/families");
    },
    onError: failed(t("finance.families.manage.deleteError")),
  });

  const guardianName = new Map(family.guardians.map((g) => [g.user_id, g.name]));
  const childName = new Map(family.children.map((c) => [c.student_id, c.name]));
  const links = detail.data?.links ?? [];

  const primaryOptions: SelectOption<string>[] = family.guardians.map((guardian) => ({
    value: guardian.user_id,
    label: guardian.name,
  }));

  function saveDetails(event: FormEvent) {
    event.preventDefault();
    const body: { display_name?: string; primary_parent_user_id?: string } = {};
    if (name.trim() && name.trim() !== family.display_name) body.display_name = name.trim();
    if (primaryId && primaryId !== primary) body.primary_parent_user_id = primaryId;
    if (Object.keys(body).length > 0) update.mutate(body);
  }

  return (
    <Card as="section" aria-label={t("finance.families.manage.title")}>
      <Card.Body>
        <h2>{t("finance.families.manage.title")}</h2>
        <p>{t("finance.families.manage.intro")}</p>

        <form className="families-manage__form" onSubmit={saveDetails}>
          <Input
            label={t("finance.families.manage.name")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
          {primaryOptions.length > 0 ? (
            <Select
              label={t("finance.families.manage.primary")}
              options={primaryOptions}
              value={primaryId}
              onChange={setPrimaryId}
            />
          ) : null}
          <Button type="submit" variant="secondary" loading={update.isPending}>
            {t("finance.families.manage.save")}
          </Button>
        </form>

        <h3>{t("finance.families.manage.links")}</h3>
        {links.length === 0 ? (
          <>
            <p>{t("finance.families.manage.noLinks")}</p>
            <Button
              type="button"
              variant="secondary"
              loading={deleteFamily.isPending}
              onClick={() => deleteFamily.mutate()}
            >
              {t("finance.families.manage.delete")}
            </Button>
          </>
        ) : (
          <ul className="families-manage__links">
            {links.map((link) => {
              const label = t("finance.families.manage.link", {
                guardian: guardianName.get(link.parent_user_id) ?? link.parent_user_id,
                child: childName.get(link.student_id) ?? link.student_id,
              });
              const isMoving =
                moving?.parent_user_id === link.parent_user_id &&
                moving.student_id === link.student_id;
              return (
                <li key={`${link.parent_user_id}:${link.student_id}`}>
                  <span>{label}</span>
                  <div className="families-manage__link-actions">
                    <Button
                      type="button"
                      variant="tertiary"
                      onClick={() => setMoving(isMoving ? null : link)}
                    >
                      {t("finance.families.manage.move")}
                    </Button>
                    {canUnlink ? (
                      <Button
                        type="button"
                        variant="tertiary"
                        loading={removeLink.isPending}
                        onClick={() => removeLink.mutate(link)}
                      >
                        {t("finance.families.manage.remove")}
                      </Button>
                    ) : null}
                  </div>
                  {isMoving ? (
                    <div className="families-manage__move">
                      <Input
                        type="search"
                        label={t("finance.families.manage.moveTo", { link: label })}
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                      <ul className="families-manage__targets">
                        {(targets.data ?? [])
                          .filter((target) => target.id !== family.id)
                          .map((target) => (
                            <li key={target.id}>
                              <Button
                                type="button"
                                variant="secondary"
                                loading={moveLink.isPending}
                                onClick={() => moveLink.mutate({ link, targetFamilyId: target.id })}
                              >
                                {target.display_name}
                              </Button>
                            </li>
                          ))}
                      </ul>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card.Body>
    </Card>
  );
}
