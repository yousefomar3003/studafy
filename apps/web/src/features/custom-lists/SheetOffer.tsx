import { PERMISSIONS } from "@studafy/constants";
import { Button } from "@studafy/ui";
import { useNavigate } from "react-router-dom";

// The defining module, not the `lib/auth` barrel: the import screens that render this offer are
// tested with that barrel stubbed down to the session store.
import { usePermissions } from "../../lib/auth/context";
import { useTranslation } from "../../lib/i18n";

import { LISTS_PATH } from "./queries";
import { setPendingSheet } from "./sheet-handoff";

import "./custom-lists.css";

import type { PendingSheet } from "./sheet-handoff";

export interface SheetOfferProps {
  sheet: PendingSheet;
  /** Called before leaving for the list import, e.g. to close the dialog the offer sits in. */
  onLeave?: () => void;
}

/**
 * "Studafy doesn't recognise this sheet: create a custom list from it." Shown by an import when
 * none of the file's columns matched anything it knows. The file is handed over in memory; nothing
 * is uploaded until the list import's own confirm. Render it only for `customList:manage` holders:
 * {@link ManagerSheetOffer} checks, a screen only leadership can open (the student import) need not.
 */
export function SheetOffer({ sheet, onLeave }: SheetOfferProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="custom-lists__offer" role="note">
      <p>{t("dataTransfer.customList.unrecognised")}</p>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setPendingSheet(sheet);
          onLeave?.();
          navigate(`${LISTS_PATH}/import`);
        }}
      >
        {t("dataTransfer.customList.create")}
      </Button>
    </div>
  );
}

/** {@link SheetOffer}, shown only to `customList:manage` holders. */
export function ManagerSheetOffer(props: SheetOfferProps) {
  const permissions = usePermissions();
  return permissions.has(PERMISSIONS.CUSTOM_LIST_MANAGE) ? <SheetOffer {...props} /> : null;
}
