/**
 * A payment receipt as a one-page PDF, rendered by Studafy from the finance cache.
 *
 * Not ERPNext's own print format: that needs ERPNext's PDF renderer to reach the school's site over
 * its own hostname, which fails wherever that name does not resolve from inside the ERPNext
 * container, and a parent's app cannot authenticate to ERPNext at all. Rendering here means the
 * receipt is available exactly when the payment is in the cache, in the reader's language.
 *
 * Latin text is ordinary PDF text in Helvetica. Arabic is laid out by fontkit with Noto Sans Arabic
 * (shaping, right-to-left order, and the GPOS offsets that place each letter's dots) and each glyph
 * is drawn as a vector path. Embedding the font instead does not work: pdf-lib cannot embed a WOFF
 * font program, and it draws glyphs by advance width alone, so the dots this font positions as
 * separate marks would land in the wrong place.
 */

import notoSansArabic from "@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff" with { type: "file" };
import * as fontkitModule from "@pdf-lib/fontkit";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

import type { PDFFont, PDFPage, RGB } from "pdf-lib";

export interface ReceiptInput {
  locale: "en" | "ar";
  schoolName: string;
  receiptNumber: string;
  paymentDate: string;
  status: "pending" | "confirmed" | "failed";
  studentName: string;
  admissionNumber: string;
  familyName: string | null;
  invoiceId: string | null;
  amount: string;
  currency: string;
  paymentMode: "cash" | "bank_transfer" | "card_external" | null;
  generatedAt: Date;
}

const LABELS = {
  en: {
    title: "Payment receipt",
    receiptNumber: "Receipt number",
    date: "Payment date",
    student: "Student",
    admission: "Admission number",
    family: "Family",
    invoice: "Invoice",
    method: "Payment method",
    status: "Status",
    amount: "Amount received",
    modes: { cash: "Cash", bank_transfer: "Bank transfer", card_external: "Card" },
    statuses: {
      pending: "Recorded — awaiting confirmation",
      confirmed: "Confirmed",
      failed: "Not completed",
    },
    footer: "Issued by Studafy on {date}. Keep this receipt for your records.",
  },
  ar: {
    title: "إيصال دفع",
    receiptNumber: "رقم الإيصال",
    date: "تاريخ الدفع",
    student: "الطالب",
    admission: "الرقم المدرسي",
    family: "العائلة",
    invoice: "الفاتورة",
    method: "طريقة الدفع",
    status: "الحالة",
    amount: "المبلغ المستلم",
    modes: { cash: "نقدًا", bank_transfer: "تحويل بنكي", card_external: "بطاقة" },
    statuses: { pending: "مسجّلة — بانتظار التأكيد", confirmed: "مؤكدة", failed: "لم تكتمل" },
    footer: "صدر عن Studafy بتاريخ {date}. يرجى الاحتفاظ بهذا الإيصال.",
  },
} as const;

// The minimal slice of fontkit this file uses. @pdf-lib/fontkit ships no usable types for layout.
interface GlyphPath {
  scale(x: number, y: number): GlyphPath;
  toSVG(): string;
}
interface LayoutFont {
  unitsPerEm: number;
  layout(text: string): {
    glyphs: { path: GlyphPath }[];
    positions: { xAdvance: number; xOffset: number; yOffset: number }[];
  };
}
interface Fontkit {
  create(buffer: Buffer): LayoutFont;
}
const fontkit = ((fontkitModule as unknown as { default?: Fontkit }).default ??
  fontkitModule) as unknown as Fontkit;

let arabicFont: Promise<LayoutFont> | null = null;
function loadArabicFont(): Promise<LayoutFont> {
  arabicFont ??= Bun.file(notoSansArabic)
    .arrayBuffer()
    .then((bytes) => fontkit.create(Buffer.from(bytes)));
  return arabicFont;
}

/** Arabic letters, harakat and presentation forms. */
const ARABIC = /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/;
const NEUTRAL = /[\s\u060c\u061b\u061f.,:;!?()\-\u2013\u2014"'\u00ab\u00bb]/;

interface Run {
  text: string;
  arabic: boolean;
}

/**
 * Split a line into Arabic and non-Arabic runs, in logical order. Spaces and punctuation between
 * two Arabic letters stay inside the Arabic run, so a phrase is laid out (and joined) as one; at a
 * script boundary they go with the Latin side.
 */
function splitRuns(text: string): Run[] {
  const characters = [...text];
  const isArabicAt = (index: number): boolean => {
    const character = characters[index]!;
    if (ARABIC.test(character)) return true;
    if (!NEUTRAL.test(character)) return false;
    let before = index - 1;
    while (before >= 0 && NEUTRAL.test(characters[before]!)) before -= 1;
    let after = index + 1;
    while (after < characters.length && NEUTRAL.test(characters[after]!)) after += 1;
    return (
      before >= 0 &&
      after < characters.length &&
      ARABIC.test(characters[before]!) &&
      ARABIC.test(characters[after]!)
    );
  };

  const runs: Run[] = [];
  characters.forEach((character, index) => {
    const arabic = isArabicAt(index);
    const last = runs.at(-1);
    if (last && last.arabic === arabic) last.text += character;
    else runs.push({ text: character, arabic });
  });
  return runs;
}

/** Characters Helvetica's WinAnsi encoding cannot draw become "?", rather than failing the PDF. */
function latinSafe(value: string): string {
  return value.replace(
    /[^\u0020-\u007e\u00a0-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2026]/g,
    "?",
  );
}

interface TextStyle {
  size: number;
  bold?: boolean;
  color?: RGB;
}

class TextPainter {
  constructor(
    private readonly page: PDFPage,
    private readonly latin: PDFFont,
    private readonly latinBold: PDFFont,
    private readonly arabic: LayoutFont,
    private readonly rtl: boolean,
  ) {}

  /** Runs in drawing (left-to-right) order: an RTL line reads its runs right to left. */
  private visualRuns(text: string): Run[] {
    const runs = splitRuns(text);
    return this.rtl ? runs.reverse() : runs;
  }

  private runWidth(run: Run, style: TextStyle): number {
    if (run.arabic) {
      const scale = style.size / this.arabic.unitsPerEm;
      return this.arabic
        .layout(run.text)
        .positions.reduce((sum, position) => sum + position.xAdvance * scale, 0);
    }
    const font = style.bold ? this.latinBold : this.latin;
    return font.widthOfTextAtSize(latinSafe(run.text), style.size);
  }

  width(text: string, style: TextStyle): number {
    return this.visualRuns(text).reduce((sum, run) => sum + this.runWidth(run, style), 0);
  }

  draw(text: string, x: number, y: number, style: TextStyle): void {
    const color = style.color ?? rgb(0.08, 0.12, 0.18);
    let penX = x;
    for (const run of this.visualRuns(text)) {
      if (!run.arabic) {
        const font = style.bold ? this.latinBold : this.latin;
        const value = latinSafe(run.text);
        this.page.drawText(value, { x: penX, y, size: style.size, font, color });
        penX += font.widthOfTextAtSize(value, style.size);
        continue;
      }
      // fontkit returns the run's glyphs already in visual order, with mark offsets.
      const scale = style.size / this.arabic.unitsPerEm;
      const { glyphs, positions } = this.arabic.layout(run.text);
      glyphs.forEach((glyph, index) => {
        const position = positions[index]!;
        // Font units are y-up; drawSvgPath reads SVG's y-down, so flip while scaling.
        const path = glyph.path.scale(scale, -scale).toSVG();
        if (path) {
          this.page.drawSvgPath(path, {
            x: penX + position.xOffset * scale,
            y: y + position.yOffset * scale,
            color,
          });
        }
        penX += position.xAdvance * scale;
      });
    }
  }
}

export async function renderReceiptPdf(input: ReceiptInput): Promise<Uint8Array> {
  const labels = LABELS[input.locale];
  const rtl = input.locale === "ar";

  const document = await PDFDocument.create();
  document.setTitle(`${LABELS.en.title} ${input.receiptNumber}`);
  document.setCreator("Studafy");
  document.setCreationDate(input.generatedAt);

  const page = document.addPage([595, 842]);
  const painter = new TextPainter(
    page,
    await document.embedFont(StandardFonts.Helvetica),
    await document.embedFont(StandardFonts.HelveticaBold),
    await loadArabicFont(),
    rtl,
  );
  const margin = 56;
  const right = page.getWidth() - margin;
  const muted = rgb(0.38, 0.43, 0.5);
  const accent = rgb(0.15, 0.39, 0.92);
  const rule = (y: number) =>
    page.drawLine({
      start: { x: margin, y },
      end: { x: right, y },
      thickness: 1,
      color: rgb(0.86, 0.88, 0.91),
    });

  /** Draw text at the reading-start edge (left in LTR, right in RTL), or `offset` in from it. */
  const line = (value: string, y: number, style: TextStyle & { offset?: number }) => {
    const offset = style.offset ?? 0;
    const x = rtl ? right - offset - painter.width(value, style) : margin + offset;
    painter.draw(value, x, y, style);
  };

  let y = page.getHeight() - margin - 10;
  line(input.schoolName, y, { size: 18, bold: true });
  y -= 28;
  line(labels.title, y, { size: 13, bold: true, color: accent });
  y -= 14;
  rule(y);
  y -= 30;

  line(labels.amount, y, { size: 10, color: muted });
  y -= 26;
  line(`${input.amount} ${input.currency}`, y, { size: 24, bold: true });
  y -= 36;

  const rows: [string, string][] = [
    [labels.receiptNumber, input.receiptNumber],
    [labels.date, input.paymentDate],
    [labels.student, input.studentName],
    [labels.admission, input.admissionNumber],
  ];
  if (input.familyName) rows.push([labels.family, input.familyName]);
  if (input.invoiceId) rows.push([labels.invoice, input.invoiceId]);
  if (input.paymentMode) rows.push([labels.method, labels.modes[input.paymentMode]]);
  rows.push([labels.status, labels.statuses[input.status]]);

  for (const [label, value] of rows) {
    line(label, y, { size: 10, color: muted });
    line(value, y, { size: 11, offset: 170 });
    y -= 24;
  }

  y -= 12;
  rule(y);
  y -= 22;
  line(labels.footer.replace("{date}", input.generatedAt.toISOString().slice(0, 10)), y, {
    size: 9,
    color: muted,
  });

  return document.save();
}
