/**
 * README.txt, the first thing a person opening an export should read: whose data it is, what each
 * folder holds, and what the export could not include. Plain text, so it opens anywhere, in
 * English with a short Arabic summary. The details stay in manifest.json; for a whole school this
 * lists folders and data files, not every one of the school's files.
 */

import { EXPORT_FILE_FOLDERS } from "./export-files";

import type { ExportManifest } from "./export-manifest";

const FOLDER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  submissions: "files attached to assignment submissions",
  "assignment-attachments": "files attached to assignments",
  materials: "class materials",
  "question-images": "pictures used in assignment questions",
  "record-documents": "documents attached to student, parent and staff records",
  "expense-attachments": "files attached to school expenses",
  "payment-receipts": "receipts for the school's Studafy subscription payments",
  "student-imports": "original files uploaded to import students",
};

export interface ExportReadmeInput {
  manifest: ExportManifest;
  schoolName: string;
  /** The person's name, for a per-person export. */
  subjectName: string | null;
}

function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function renderExportReadme({
  manifest,
  schoolName,
  subjectName,
}: ExportReadmeInput): string {
  const prepared = formatUtc(manifest.generatedAt);
  const whose =
    manifest.subjectScope === "user"
      ? `the personal data ${schoolName} holds in Studafy about ${subjectName ?? "one person"}`
      : `all of the data ${schoolName} holds in Studafy`;

  const lines: string[] = [
    "STUDAFY DATA EXPORT",
    "===================",
    "",
    `This archive holds ${whose}, as it was on ${prepared}.`,
    "",
    `Request: ${manifest.requestId}`,
    `Prepared: ${prepared}`,
    `Scope: ${manifest.subjectScope === "user" ? `one person (${subjectName ?? manifest.subjectUserId})` : "the whole school"}`,
    "",
    "WHAT IS INSIDE",
    "--------------",
    "",
    "data/",
    "  One file per kind of record, in JSON: a list with one record per line. Open it with a text",
    "  editor or a web browser, or import it into a spreadsheet.",
  ];
  if (manifest.tables.length === 0) {
    lines.push("  (no records)");
  }
  for (const table of manifest.tables) {
    lines.push(`  ${table.path}: ${plural(table.rowCount, "record", "records")}`);
  }

  const copied = manifest.files.filter((file) => file.path !== null);
  const missing = manifest.files.length - copied.length;
  lines.push("", "files/", "  Copies of the files that were uploaded.");
  if (copied.length === 0) lines.push("  (no files)");
  const folders = new Map<string, number>();
  for (const file of copied) {
    const folder = EXPORT_FILE_FOLDERS[file.table] ?? "other";
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }
  for (const [folder, count] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
    const description = FOLDER_DESCRIPTIONS[folder] ?? "other files";
    lines.push(`  files/${folder}/: ${plural(count, "file", "files")}, ${description}`);
  }

  lines.push(
    "",
    "manifest.json",
    "  A machine-readable list of everything in this archive: each data file's record count and",
    "  each file's original name, size and SHA-256 checksum, to check that nothing was changed.",
    "",
    "NOT INCLUDED",
    "------------",
    "",
  );
  const gaps = [...manifest.knownGaps];
  if (missing > 0) {
    gaps.push(
      `${plural(missing, "file is", "files are")} listed in manifest.json with no path: ` +
        "nothing was stored under them any more when this export was prepared.",
    );
  }
  if (gaps.length === 0) lines.push("Nothing that we know of.");
  for (const gap of gaps) lines.push(`- ${gap}`);

  lines.push(
    "",
    "This archive contains personal data. Keep it somewhere safe and delete it when it is no",
    "longer needed. Questions about it go to the school.",
    "",
    "",
    "تصدير بيانات Studafy",
    "",
    manifest.subjectScope === "user"
      ? `يحتوي هذا الأرشيف على البيانات الشخصية التي تحتفظ بها المدرسة في Studafy عن ${subjectName ?? "شخص واحد"}، كما كانت في ${prepared}.`
      : `يحتوي هذا الأرشيف على جميع البيانات التي تحتفظ بها المدرسة في Studafy، كما كانت في ${prepared}.`,
    "",
    "- المجلد data: ملف لكل نوع من السجلات بصيغة JSON، سجلّ واحد في كل سطر.",
    "- المجلد files: نُسخ من الملفات التي رُفعت.",
    "- الملف manifest.json: قائمة بكل محتويات الأرشيف، مع بصمة SHA-256 لكل ملف للتحقق من سلامته.",
    "- ما لم يشمله هذا التصدير مذكور بالإنجليزية أعلاه تحت NOT INCLUDED.",
    "",
    "يحتوي هذا الأرشيف على بيانات شخصية، فاحفظه في مكان آمن واحذفه حين لا تعود بحاجة إليه.",
    "",
  );
  return lines.join("\n");
}
