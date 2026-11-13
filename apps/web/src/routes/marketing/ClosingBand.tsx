import { LinkButton } from "../../components/LinkButton";
import { useTranslation } from "../../lib/i18n";

/** The navy band near the end of every marketing page (home, features, pricing, about): one
 * sentence and one way forward. */
export function ClosingBand({
  titleKey = "site.marketing.home.closingTitle",
}: {
  titleKey?: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="mk-band" aria-labelledby="mk-closing">
      {/* Shown as is, not revealed on scroll: the last thing on the page stays still. */}
      <div className="marketing-container mk-band__inner">
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
