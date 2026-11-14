import type { Formatters } from "../../lib/i18n";
import type { TFunction } from "i18next";

const GIB = 1024 ** 3;

/** "8.2 GB", "100 GB", "1 TB": whole units where they are whole, one decimal otherwise. */
export function formatStorage(
  bytes: number,
  t: TFunction,
  formatNumber: Formatters["formatNumber"],
): string {
  const unit = (value: number) =>
    formatNumber(value, { maximumFractionDigits: Number.isInteger(value) ? 0 : 1 });
  if (bytes >= 1024 * GIB)
    return t("schoolLicense.storage.units.tb", { value: unit(bytes / (1024 * GIB)) });
  if (bytes >= GIB)
    return t("schoolLicense.storage.units.gb", {
      value: unit(Math.round((bytes / GIB) * 10) / 10),
    });
  return t("schoolLicense.storage.units.mb", { value: unit(Math.round(bytes / 1024 ** 2)) });
}
