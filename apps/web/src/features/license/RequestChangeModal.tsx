import { ApiError } from "@studafy/api-client";
import { isLicensableAudience } from "@studafy/constants";
import { Button, Input, Modal, Select, useToast } from "@studafy/ui";
import { useState } from "react";

import { useTranslation } from "../../lib/i18n";

import {
  EMPTY_TERMS,
  LicenceTermsFields,
  inForce,
  termsErrors,
  termsPayload,
  utcToday,
} from "./LicenceTermsFields";
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

/** The audiences a school can ask for: only those a license sells (today, students). */
const REQUESTABLE = AUDIENCES.filter(isLicensableAudience);

/**
 * "Request AI for students": how many students should get Studafy AI, the AI tier, for how many
 * months and how the school wants to pay (monthly, yearly or its own dates), and an optional note.
 * It creates a request for the super admin, who prices it as a quote -- keeping the school's length
 * and plan, or changing them with a reason the school reads; nothing on the license changes until
 * the school accepts that quote. Teacher and parent seats and Family+ appear here only once
 * their features are built (`LICENSABLE_AUDIENCES`).
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
  const [terms, setTerms] = useState(EMPTY_TERMS);
  // A licence in force keeps its end date unless the school asks for more months.
  const [termsFor, setTermsFor] = useState<string | null>(null);
  const termsKey = inForce(license) ? license.id : "new";
  if (termsFor !== termsKey) {
    setTermsFor(termsKey);
    setTerms({ ...EMPTY_TERMS, length: inForce(license) ? "" : EMPTY_TERMS.length });
  }
  const today = utcToday();
  const termsInvalid = termsErrors(terms, license, today).length > 0;
  const changesTerms = inForce(license) && terms.length !== "";

  const offersFamilyPlus = isLicensableAudience("parent");
  const hasFamilyPlus = license?.includeFamilyPlus ?? false;
  const parentsShown =
    offersFamilyPlus && (familyPlus === "include" || (hasFamilyPlus && familyPlus !== "remove"));
  const audiences = REQUESTABLE.filter((a) => a !== "parent" || parentsShown);
  const seatsInvalid = (value: string) => value !== "" && !/^\d{1,6}$/.test(value);
  const invalid = audiences.some((a) => seatsInvalid(wishes[a].seats));
  const asksSomething =
    familyPlus !== "same" ||
    changesTerms ||
    audiences.some((a) => wishes[a].seats !== "" || wishes[a].planId);
  // With no license yet, the request is for a first one: it needs a number of students.
  const needsStudents = license === null && wishes.student.seats === "";
  const valid = !invalid && asksSomething && !needsStudents && !termsInvalid;

  function close() {
    setWishes(EMPTY);
    setFamilyPlus("same");
    setNote("");
    setTerms({ ...EMPTY_TERMS, length: inForce(license) ? "" : EMPTY_TERMS.length });
    onClose();
  }

  function submit() {
    if (!valid || request.isPending) return;
    const wish = (audience: LicenseAudience) =>
      audiences.includes(audience) ? wishes[audience] : { seats: "", planId: "" };
    const studentSeats = wish("student").seats === "" ? null : Number(wish("student").seats);
    const tier = tiers.find((candidate) => candidate.id === wish("student").planId);
    request.mutate(
      {
        studentSeats,
        teacherSeats: wish("teacher").seats === "" ? null : Number(wish("teacher").seats),
        parentSeats: wish("parent").seats === "" ? null : Number(wish("parent").seats),
        studentPlanId: wish("student").planId || null,
        teacherPlanId: wish("teacher").planId || null,
        parentPlanId: wish("parent").planId || null,
        includeFamilyPlus:
          !offersFamilyPlus || familyPlus === "same" ? null : familyPlus === "include",
        ...termsPayload(terms, license),
        // The note is optional for the school; the request always carries one for the inbox.
        note:
          note.trim() ||
          (studentSeats !== null
            ? t("schoolLicense.aiRequest.defaultNote", {
                count: studentSeats,
                tier: tier?.displayName ?? t("schoolLicense.aiRequest.anyTierShort"),
              })
            : t("schoolLicense.aiRequest.defaultNoteTier", {
                tier: tier?.displayName ?? t("schoolLicense.aiRequest.anyTierShort"),
              })),
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
      title={t("schoolLicense.aiRequest.title")}
      description={t("schoolLicense.aiRequest.description")}
    >
      <Modal.Body>
        {audiences.map((audience) => {
          const current = license?.audiences.find((a) => a.audience === audience);
          const audienceName = t(`schoolLicense.audience.${audience}`);
          const isStudents = audience === "student";
          return (
            <fieldset key={audience} className="license-toolbar">
              <legend className="sf-visually-hidden">{audienceName}</legend>
              <Input
                label={
                  isStudents
                    ? t("schoolLicense.aiRequest.studentsLabel")
                    : t("schoolLicense.request.seatsLabel", { audience: audienceName })
                }
                helperText={
                  current && current.purchased > 0
                    ? t("schoolLicense.request.seatsNow", { count: current.purchased })
                    : isStudents
                      ? t("schoolLicense.aiRequest.studentsHelp")
                      : undefined
                }
                inputMode="numeric"
                value={wishes[audience].seats}
                required={isStudents && license === null}
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
                label={
                  isStudents
                    ? t("schoolLicense.aiRequest.tierLabel")
                    : t("schoolLicense.request.tierLabel", { audience: audienceName })
                }
                value={wishes[audience].planId}
                onChange={(planId) =>
                  setWishes((prev) => ({ ...prev, [audience]: { ...prev[audience], planId } }))
                }
                options={[
                  {
                    value: "",
                    label: current?.tier
                      ? t("schoolLicense.request.keepTier", { tier: current.tier.displayName })
                      : t("schoolLicense.aiRequest.anyTier"),
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
        {offersFamilyPlus ? (
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
        ) : null}
        <LicenceTermsFields value={terms} onChange={setTerms} license={license} today={today} />
        <Input
          label={t("schoolLicense.aiRequest.noteLabel")}
          helperText={t("schoolLicense.request.noteHelp")}
          value={note}
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
          disabled={!valid || request.isPending}
          loading={request.isPending}
          onClick={submit}
        >
          {t("schoolLicense.aiRequest.submit")}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
