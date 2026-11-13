import { LinkButton } from "../../components/LinkButton";
import { useTranslation } from "../../lib/i18n";

import { reveal } from "./reveal";

/** The navy band that ends the home and features pages: one sentence and one way forward. */
export function ClosingBand({
  titleKey = "site.marketing.home.closingTitle",
}: {
  titleKey?: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="mk-band" aria-labelledby="mk-closing">
      <div className="marketing-container mk-band__inner" {...reveal()}>
        <div>
          <h2 id="mk-closing" className="mk-band__title">
            {t(titleKey)}
          </h2>
          <p className="mk-band__body">{t("site.marketing.home.closingBody")}</p>
        </div>
        <LinkButton href="/about#contact" variant="secondary">
          {t("site.marketing.cta.talkToUs")}
        </LinkButton>
      </div>
    </section>
  );
}
