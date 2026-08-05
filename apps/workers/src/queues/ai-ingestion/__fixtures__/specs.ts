/**
 * The fixture corpus for the AI-ingestion parsers: 26 documents covering valid PDFs, valid DOCX
 * files, valid PPTX decks, corrupt files, and unsupported legacy formats. `generate.ts` materialises
 * the files (committed under `files/`); this manifest is the test-side truth for what each file must
 * yield.
 *
 * - `anchors`: phrases of body text that must survive extraction verbatim.
 * - `headings`: section headings the parser must recognise, in document order.
 * - `ingestError`: the reason a corrupt/unsupported file must be recorded with.
 */
export interface FixtureSpec {
  file: string;
  mimeType: string;
  description: string;
  kind: "pdf" | "docx" | "pptx" | "corrupt" | "unsupported";
  /** Expected page count for valid PDFs. */
  pages?: number;
  /** Expected slide count for valid PPTX decks. */
  slides?: number;
  /** Body-text phrases that must appear in the extracted chunks. */
  anchors?: string[];
  /** Section headings the parser must detect, in document order. */
  headings?: string[];
  /** The `ingest_error` reason a corrupt or unsupported file must be marked with. */
  ingestError?: string;
}

export const FIXTURES: readonly FixtureSpec[] = [
  {
    file: "photosynthesis-guide.pdf",
    mimeType: "application/pdf",
    description: "3-page biology study guide with section headings in a larger font.",
    kind: "pdf",
    pages: 3,
    anchors: [
      "Photosynthesis converts light energy into chemical energy stored in glucose",
      "Chlorophyll absorbs mostly red and blue light",
      "The Calvin cycle fixes carbon dioxide",
    ],
    headings: [
      "Introduction to Photosynthesis",
      "Light Absorption",
      "Light Reactions",
      "The Calvin Cycle",
    ],
  },
  {
    file: "cell-biology-notes.pdf",
    mimeType: "application/pdf",
    description: "2-page cell biology notes.",
    kind: "pdf",
    pages: 2,
    anchors: ["The nucleus stores genetic material in chromosomes"],
    headings: ["The Cell", "Organelles", "The Nucleus"],
  },
  {
    file: "algebra-functions.pdf",
    mimeType: "application/pdf",
    description: "1-page algebra reference sheet.",
    kind: "pdf",
    pages: 1,
    anchors: ["A linear function has the form y equals mx plus b"],
    headings: ["Linear Functions", "Quadratic Functions"],
  },
  {
    file: "history-ww1-chapter.pdf",
    mimeType: "application/pdf",
    description: "4-page history chapter on the First World War.",
    kind: "pdf",
    pages: 4,
    anchors: ["The war began in the summer of 1914", "The Treaty of Versailles was signed in 1919"],
    headings: ["Causes of the War", "The Western Front", "The Armistice"],
  },
  {
    file: "physics-formula-sheet.pdf",
    mimeType: "application/pdf",
    description: "1-page physics formula sheet.",
    kind: "pdf",
    pages: 1,
    anchors: ["Force equals mass times acceleration"],
    headings: ["Mechanics"],
  },
  {
    file: "chemistry-lab-manual.pdf",
    mimeType: "application/pdf",
    description: "2-page chemistry lab manual.",
    kind: "pdf",
    pages: 2,
    anchors: ["Titration is used to determine an unknown concentration"],
    headings: ["Safety", "Titration Procedure"],
  },
  {
    file: "long-readings-chapter.pdf",
    mimeType: "application/pdf",
    description: "8-page chapter long enough to exercise chunk splitting.",
    kind: "pdf",
    pages: 8,
    anchors: [
      "Water is split during photolysis releasing oxygen",
      "Net productivity depends on light intensity",
    ],
    headings: [
      "Overview",
      "Light Absorption",
      "Light Reactions",
      "Calvin Cycle",
      "Photolysis",
      "Limiting Factors",
    ],
  },
  {
    file: "literature-notes.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    description: "DOCX literature notes with Heading1/Heading2 styles.",
    kind: "docx",
    headings: ["Romeo and Juliet", "Themes", "Love"],
    anchors: ["The play explores love and fate in equal measure"],
  },
  {
    file: "geography-study-guide.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    description: "DOCX geography guide with three Heading1 sections.",
    kind: "docx",
    headings: ["Rivers", "Coasts", "Glaciers"],
    anchors: ["A river erodes its channel and carries sediment downstream"],
  },
  {
    file: "computer-science-basics.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    description: "DOCX computer science notes.",
    kind: "docx",
    headings: ["Algorithms", "Data Structures", "Complexity"],
    anchors: ["An algorithm is a finite sequence of well-defined steps"],
  },
  {
    file: "mathematics-calculus.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    description: "DOCX calculus notes with a Heading2 under a Heading1.",
    kind: "docx",
    headings: ["Differentiation", "The Derivative"],
    anchors: ["The derivative measures the rate of change of a function"],
  },
  {
    file: "history-notes.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    description: "DOCX history notes.",
    kind: "docx",
    headings: ["The Enlightenment", "Revolutions"],
    anchors: ["Philosophers argued for reason and individual rights"],
  },
  {
    file: "long-study-guide.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    description: "DOCX with long body paragraphs that force hard chunk splits.",
    kind: "docx",
    headings: ["Introduction", "Detailed Analysis"],
    anchors: ["The mitochondria are often described as the powerhouse of the cell"],
  },
  {
    file: "photosynthesis-deck.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    description: "3-slide biology deck with titled slides and speaker notes.",
    kind: "pptx",
    slides: 3,
    anchors: [
      "Photosynthesis converts light energy into chemical energy stored in glucose",
      "Chlorophyll absorbs mostly red and blue light",
      "Emphasize that the cycle repeats three times",
    ],
    headings: ["Photosynthesis", "Light Reactions", "The Calvin Cycle"],
  },
  {
    file: "solar-system-deck.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    description:
      "2-slide deck whose second slide has no title, so chunks must fence on slide number.",
    kind: "pptx",
    slides: 2,
    anchors: [
      "The Sun contains most of the mass of the solar system",
      "Jupiter is the largest planet by mass",
      "Cover the gas giants and how each was found",
    ],
    headings: ["The Solar System"],
  },
  {
    file: "corrupt-not-a-pdf.pdf",
    mimeType: "application/pdf",
    description: "Plain text with a .pdf extension.",
    kind: "corrupt",
    ingestError: "file is not a valid PDF",
  },
  {
    file: "corrupt-empty.pdf",
    mimeType: "application/pdf",
    description: "A zero-byte file claiming to be a PDF.",
    kind: "corrupt",
    ingestError: "file is not a valid PDF",
  },
  {
    file: "corrupt-truncated-pdf.pdf",
    mimeType: "application/pdf",
    description: "A well-formed PDF cut off halfway through.",
    kind: "corrupt",
    ingestError: "file is not a valid PDF",
  },
  {
    file: "corrupt-not-a-docx.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    description: "Plain text with a .docx extension.",
    kind: "corrupt",
    ingestError: "file is not a valid DOCX",
  },
  {
    file: "corrupt-docx-missing-part.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    description: "A valid zip that is not a DOCX (no word/document.xml).",
    kind: "corrupt",
    ingestError: "file is not a valid DOCX",
  },
  {
    file: "corrupt-empty.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    description: "A zero-byte file claiming to be a DOCX.",
    kind: "corrupt",
    ingestError: "file is not a valid DOCX",
  },
  {
    file: "corrupt-not-a-pptx.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    description: "Plain text with a .pptx extension.",
    kind: "corrupt",
    ingestError: "file is not a valid PPTX",
  },
  {
    file: "corrupt-empty.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    description: "A zero-byte file claiming to be a PPTX.",
    kind: "corrupt",
    ingestError: "file is not a valid PPTX",
  },
  {
    file: "corrupt-pptx-missing-presentation.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    description: "A valid zip that is not a PPTX (no ppt/presentation.xml).",
    kind: "corrupt",
    ingestError: "file is not a valid PPTX",
  },
  {
    file: "unsupported-legacy-ppt.ppt",
    mimeType: "application/vnd.ms-powerpoint",
    description: "A legacy binary .ppt: a format the pipeline does not parse.",
    kind: "unsupported",
    ingestError: "unsupported mime type: application/vnd.ms-powerpoint",
  },
  {
    file: "unsupported-legacy-doc.doc",
    mimeType: "application/msword",
    description: "A legacy binary .doc: a format the pipeline does not parse.",
    kind: "unsupported",
    ingestError: "unsupported mime type: application/msword",
  },
];
