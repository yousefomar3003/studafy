import { ApiError } from "@studafy/api-client";
import { Button, Card, Checkbox, Select } from "@studafy/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../../lib/api";
import { useFormatters, useTranslation } from "../../../lib/i18n";

import "./import-data.css";

type SlipRole = "STUDENT" | "PARENT" | "INSTRUCTOR";

export interface LoginSlip {
  userId: string;
  name: string;
  usernames: string[];
  setupCode: string;
  expiresAt: string;
  classLabel: string | null;
  children: string[];
}

/** Safety stop: 40 batches of 500 is far beyond any school's roster. */
const MAX_BATCHES = 40;

/**
 * Issues codes batch by batch: everyone of `role` who cannot sign in yet, and with `reprint` also
 * those whose earlier code is still unused (paged by member ID, since they keep matching).
 */
export async function issueLoginSlips(role: SlipRole, reprint: boolean): Promise<LoginSlip[]> {
  const slips: LoginSlip[] = [];
  let after: string | undefined;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const { data } = await api.POST("/api/users/member-setup-codes", {
      body: { role, ...(reprint ? { include_pending: true } : {}), ...(after ? { after } : {}) },
    });
    // The generated client types arrays as readonly; copied out as plain ones.
    const rows = data!.issued as unknown as NonNullable<typeof data>["issued"][number][];
    for (const row of rows) {
      slips.push({
        userId: row.user_id,
        name: row.display_name ?? "",
        usernames: Array.from(row.usernames as unknown as string[]),
        setupCode: row.setup_code,
        expiresAt: row.expires_at,
        classLabel: row.class_label,
        children: Array.from(row.children as unknown as string[]),
      });
    }
    if (data!.remaining === 0 || rows.length === 0 || !data!.last) break;
    if (reprint) after = data!.last;
  }
  return slips;
}

/** Class by class, then by name: the order a teacher hands slips out in. Parents follow their
 * first child's name, so a family's slips sit together. */
export function sortSlips(slips: readonly LoginSlip[], locale: string): LoginSlip[] {
  const compare = new Intl.Collator(locale, { numeric: true, sensitivity: "base" }).compare;
  const key = (slip: LoginSlip) => [slip.classLabel ?? "￿", slip.children[0] ?? slip.name];
  return [...slips].sort((a, b) => {
    const [classA, nameA] = key(a);
    const [classB, nameB] = key(b);
    return compare(classA!, classB!) || compare(nameA!, nameB!) || compare(a.name, b.name);
  });
}

/**
 * Login slips (`/portal/admin/import/slips`): one printable slip per student, parent or teacher who
 * has not signed in yet, with their Studafy ID and a one-time setup code. They sign in with the two
 * and choose their own password; the code then stops working. Codes are shown only here and only
 * now (the server keeps just a hash), so the page says to print before leaving. A reprint replaces
 * codes not used yet, which makes earlier slips stop working.
 */
export default function LoginSlipsPage() {
  const { t, i18n } = useTranslation();
  const { formatDate } = useFormatters();
  const [role, setRole] = useState<SlipRole>("STUDENT");
  const [reprint, setReprint] = useState(false);
  const [slips, setSlips] = useState<LoginSlip[] | null>(null);
  const issue = useMutation({
    mutationFn: () => issueLoginSlips(role, reprint),
    onSuccess: (issued) => setSlips(sortSlips(issued, i18n.language)),
  });
  const signInUrl = `${window.location.origin}/auth/login`;

  const roleOptions = (["STUDENT", "PARENT", "INSTRUCTOR"] as const).map((value) => ({
    value,
    label: t(`adminPeople.loginSlips.roles.${value}`),
  }));

  return (
    <>
      <div className="login-slips__controls">
        <h1>{t("adminPeople.loginSlips.title")}</h1>
        <p>{t("adminPeople.loginSlips.intro")}</p>

        <Card as="section" aria-label={t("adminPeople.loginSlips.prepareRegion")}>
          <Card.Body>
            <div className="login-slips__form">
              <Select<SlipRole>
                label={t("adminPeople.loginSlips.roleLabel")}
                options={roleOptions}
                value={role}
                onChange={(value) => {
                  setRole(value);
                  setSlips(null);
                }}
              />
              <Checkbox
                label={t("adminPeople.loginSlips.reprint")}
                checked={reprint}
                onChange={(event) => setReprint(event.target.checked)}
              />
              {reprint ? (
                <p className="students-import__warning">
                  {t("adminPeople.loginSlips.reprintWarning")}
                </p>
              ) : null}
              <div>
                <Button type="button" onClick={() => issue.mutate()} disabled={issue.isPending}>
                  {issue.isPending
                    ? t("adminPeople.loginSlips.preparing")
                    : t("adminPeople.loginSlips.prepare")}
                </Button>
              </div>
            </div>
            {issue.isError ? (
              <p role="alert" className="students-import__banner">
                {issue.error instanceof ApiError
                  ? (issue.error.detail ?? issue.error.title)
                  : t("adminPeople.loginSlips.error")}
              </p>
            ) : null}
          </Card.Body>
        </Card>

        {slips && slips.length === 0 ? (
          <p role="status">{t("adminPeople.loginSlips.none")}</p>
        ) : null}
        {slips && slips.length > 0 ? (
          <div className="login-slips__ready" role="status">
            <p>{t("adminPeople.loginSlips.ready", { count: slips.length })}</p>
            <Button type="button" onClick={() => window.print()}>
              {t("adminPeople.loginSlips.print")}
            </Button>
          </div>
        ) : null}
      </div>

      {slips && slips.length > 0 ? (
        <ul className="login-slips" aria-label={t("adminPeople.loginSlips.listLabel")}>
          {slips.map((slip) => (
            <li key={slip.userId} className="login-slip">
              <p className="login-slip__name">{slip.name}</p>
              {slip.classLabel ? <p className="login-slip__detail">{slip.classLabel}</p> : null}
              {slip.children.length > 0 ? (
                <p className="login-slip__detail">
                  {t("adminPeople.loginSlips.parentOf", {
                    names: slip.children.join(t("adminPeople.common.listSeparator")),
                  })}
                </p>
              ) : null}
              <dl className="login-slip__codes">
                <div>
                  <dt>{t("adminPeople.loginSlips.id")}</dt>
                  <dd dir="ltr">{slip.usernames.join(" / ")}</dd>
                </div>
                <div>
                  <dt>{t("adminPeople.loginSlips.code")}</dt>
                  <dd dir="ltr">{slip.setupCode}</dd>
                </div>
              </dl>
              <p className="login-slip__how">
                {t("adminPeople.loginSlips.how", {
                  url: signInUrl,
                  date: formatDate(new Date(slip.expiresAt)),
                })}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
