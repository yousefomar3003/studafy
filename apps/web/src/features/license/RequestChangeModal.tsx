import { ApiError } from "@studafy/api-client";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../lib/i18n";

import { useRequestChange } from "./mutations";
import { AUDIENCES } from "./queries";

import type { LicenseAudience, OfferedTier, SchoolLicense } from "./queries";

type FamilyPlusChoice = "same" | "include" | "remove";

interface AudienceWish {
  seats: string;
  planId: string;
}

const EMPTY: Record<LicenseAudience, AudienceWish> = {
  student: { seats: "", planId: "" },
  teacher: { seats: "", planId: "" },
  parent: { seats: "", planId: "" },
};

/**
 * Ask Studafy for more (or fewer) seats, a different tier, or Family+ on or off. It creates a
 * request for the super admin; nothing on the license changes until a quote for it is accepted.
 */
export function RequestChangeModal({
  open,
  license,
  tiers,
  onClose,
}: {
  open: boolean;
  license: SchoolLicense | null;
  tiers: OfferedTier[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { show } = useToast();
  const request = useRequestChange();
  const [wishes, setWishes] = useState(EMPTY);
  const [familyPlus, setFamilyPlus] = useState<FamilyPlusChoice>("same");
  const [note, setNote] = useState("");

  const hasFamilyPlus = license?.includeFamilyPlus ?? false;
  const parentsShown = familyPlus === "include" || (hasFamilyPlus && familyPlus !== "remove");
  const audiences = AUDIENCES.filter((a) => a !== "parent" || parentsShown);
  const seatsInvalid = (value: string) => value !== "" && !/^\d{1,6}$/.test(value);
  const invalid = audiences.some((a) => seatsInvalid(wishes[a].seats));
  const asksSomething =
    familyPlus !== "same" || audiences.some((a) => wishes[a].seats !== "" || wishes[a].planId);
  const valid = !invalid && asksSomething && note.trim() !== "";

  function close() {
    setWishes(EMPTY);
    setFamilyPlus("same");
    setNote("");
    onClose();
  }

  function submit() {
    if (!valid) return;
    const wish = (audience: LicenseAudience) =>
      audiences.includes(audience) ? wishes[audience] : { seats: "", planId: "" };
    request.mutate(
      {
        studentSeats: wish("student").seats === "" ? null : Number(wish("student").seats),
        teacherSeats: wish("teacher").seats === "" ? null : Number(wish("teacher").seats),
        parentSeats: wish("parent").seats === "" ? null : Number(wish("parent").seats),
        studentPlanId: wish("student").planId || null,
        teacherPlanId: wish("teacher").planId || null,
        parentPlanId: wish("parent").planId || null,
        includeFamilyPlus: familyPlus === "same" ? null : familyPlus === "include",
        note: note.trim(),
      },
      {
        onSuccess: () => {
          show({ variant: "success", title: t("schoolLicense.request.sent") });
          close();
        },
        onError: (error) =>
          show({
            variant: "error",
            title: t("schoolLicense.request.error"),
            description: error instanceof ApiError ? (error.detail ?? error.title) : undefined,
          }),
      },
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("schoolLicense.request.title")}
      description={t("schoolLicense.request.description")}
    >
      <Modal.Body>
        {audiences.map((audience) => {
          const current = license?.audiences.find((a) => a.audience === audience);
          const audienceName = t(`schoolLicense.audience.${audience}`);
          return (
            <fieldset key={audience} className="license-toolbar">
              <legend className="sf-visually-hidden">{audienceName}</legend>
              <Input
                label={t("schoolLicense.request.seatsLabel", { audience: audienceName })}
                helperText={
                  current
                    ? t("schoolLicense.request.seatsNow", { count: current.purchased })
                    : undefined
                }
                inputMode="numeric"
                value={wishes[audience].seats}
                error={
                  seatsInvalid(wishes[audience].seats)
                    ? t("schoolLicense.request.seatsError")
                    : undefined
                }
                onChange={(event) =>
                  setWishes((prev) => ({
                    ...prev,
                    [audience]: { ...prev[audience], seats: event.target.value.trim() },
                  }))
                }
              />
              <Select
                label={t("schoolLicense.request.tierLabel", { audience: audienceName })}
                value={wishes[audience].planId}
                onChange={(planId) =>
                  setWishes((prev) => ({ ...prev, [audience]: { ...prev[audience], planId } }))
                }
                options={[
                  {
                    value: "",
                    label: current?.tier
                      ? t("schoolLicense.request.keepTier", { tier: current.tier.displayName })
                      : t("schoolLicense.request.noTierChange"),
                  },
                  ...tiers
                    .filter(
                      (tier) =>
                        tier.audience === audience &&
                        tier.isActive &&
                        tier.id !== current?.tier?.id,
                    )
                    .map((tier) => ({ value: tier.id, label: tier.displayName })),
                ]}
              />
            </fieldset>
          );
        })}
        <Select
          label={t("schoolLicense.request.familyPlusLabel")}
          value={familyPlus}
          onChange={setFamilyPlus}
          options={[
            {
              value: "same",
              label: hasFamilyPlus
                ? t("schoolLicense.request.familyPlusKeepOn")
                : t("schoolLicense.request.familyPlusKeepOff"),
            },
            hasFamilyPlus
              ? { value: "remove", label: t("schoolLicense.request.familyPlusRemove") }
              : { value: "include", label: t("schoolLicense.request.familyPlusAdd") },
          ]}
        />
        <Input
          label={t("schoolLicense.request.noteLabel")}
          helperText={t("schoolLicense.request.noteHelp")}
          value={note}
          required
          onChange={(event) => setNote(event.target.value)}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" variant="tertiary" onClick={close}>
          {t("schoolLicense.common.cancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!valid}
          loading={request.isPending}
          onClick={submit}
        >
          {t("schoolLicense.request.submit")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
