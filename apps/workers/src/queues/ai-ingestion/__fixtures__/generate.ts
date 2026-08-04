/**
 * Materialises the AI-ingestion fixture corpus in `files/`.
 *
 * Run from `apps/workers`:
 *
 *   bun run generate:fixtures
 *
 * The committed binaries were produced by this script, so regeneration is deterministic (no random
 * content) and the corpus is reviewable from `specs.ts` (expectations) plus this file (content).
 */
/* eslint-disable security/detect-non-literal-fs-filename -- a dev-only generator; every path is derived from the manifest, never user input */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { FIXTURES } from "./specs";

const FILES_DIR = join(import.meta.dir, "files");

// ---- PDF --------------------------------------------------------------------------------------

const PDF_TITLE_SIZE = 22;
const PDF_HEADING_SIZE = 15;
const PDF_BODY_SIZE = 10;

interface PdfSection {
  heading?: string;
  lines: string[];
}

/** Wrap on word boundaries at a character budget; each result becomes one PDF text line. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length > width && current !== "") {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

async function buildPdf(
  pageSpecs: { title: string; sections: PdfSection[] }[],
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const body = await pdf.embedFont(StandardFonts.Helvetica);
  const head = await pdf.embedFont(StandardFonts.HelveticaBold);

  for (const pageSpec of pageSpecs) {
    const page = pdf.addPage([612, 792]);
    let y = 740;
    page.drawText(pageSpec.title, {
      x: 60,
      y,
      size: PDF_TITLE_SIZE,
      font: head,
      color: rgb(0, 0, 0),
    });
    y -= 34;
    for (const section of pageSpec.sections) {
      if (section.heading !== undefined) {
        page.drawText(section.heading, {
          x: 60,
          y,
          size: PDF_HEADING_SIZE,
          font: head,
          color: rgb(0, 0, 0),
        });
        y -= 24;
      }
      for (const paragraph of section.lines) {
        for (const line of wrap(paragraph, 88)) {
          if (y < 60) throw new Error(`PDF content overflowed its page: "${pageSpec.title}"`);
          page.drawText(line, { x: 60, y, size: PDF_BODY_SIZE, font: body, color: rgb(0, 0, 0) });
          y -= 15;
        }
      }
      y -= 4;
    }
  }

  const bytes = await pdf.save();
  const reloaded = await PDFDocument.load(bytes);
  if (reloaded.getPageCount() !== pageSpecs.length) {
    throw new Error(
      `PDF builder made ${reloaded.getPageCount()} pages, expected ${pageSpecs.length}`,
    );
  }
  return bytes;
}

// ---- DOCX ------------------------------------------------------------------------------------

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const paragraphXml = (text: string, style?: string): string =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/></w:style>
</w:styles>`;

const documentXml = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr/></w:body>
</w:document>`;

async function buildDocx(
  title: string,
  intro: string[],
  sections: { heading: string; level: number; lines: string[] }[],
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
  zip.file("_rels/.rels", RELS_XML);
  zip.file("word/styles.xml", STYLES_XML);
  const body = [paragraphXml(title, "Title"), ...intro.map((line) => paragraphXml(line))];
  for (const section of sections) {
    body.push(paragraphXml(section.heading, section.level === 2 ? "Heading2" : "Heading1"));
    for (const line of section.lines) body.push(paragraphXml(line));
  }
  zip.file("word/document.xml", documentXml(body.join("")));
  return zip.generateAsync({ type: "nodebuffer" });
}

// ---- Corpus content --------------------------------------------------------------------------

const PDF_PAGES: Record<string, { title: string; sections: PdfSection[] }[]> = {
  "photosynthesis-guide.pdf": [
    {
      title: "Photosynthesis",
      sections: [
        {
          heading: "Introduction to Photosynthesis",
          lines: [
            "Photosynthesis converts light energy into chemical energy stored in glucose.",
            "It happens in the chloroplasts of plant cells.",
            "The overall reaction combines carbon dioxide and water to make sugar.",
          ],
        },
      ],
    },
    {
      title: "Photosynthesis",
      sections: [
        {
          heading: "Light Absorption",
          lines: [
            "Chlorophyll absorbs mostly red and blue light.",
            "Green light is reflected, which is why leaves look green.",
            "Carotenoid pigments capture extra wavelengths of light.",
          ],
        },
        {
          heading: "Light Reactions",
          lines: [
            "Light energy splits water molecules during photolysis.",
            "Electrons move through the photosystem and release energy.",
          ],
        },
      ],
    },
    {
      title: "Photosynthesis",
      sections: [
        {
          heading: "The Calvin Cycle",
          lines: [
            "The Calvin cycle fixes carbon dioxide into organic molecules.",
            "It uses ATP and NADPH produced in the light reactions.",
            "The cycle repeats three times to build one molecule of sugar.",
          ],
        },
      ],
    },
  ],
  "cell-biology-notes.pdf": [
    {
      title: "Cell Biology Notes",
      sections: [
        {
          heading: "The Cell",
          lines: [
            "Cells are the basic unit of life in all organisms.",
            "Prokaryotic cells lack a nucleus and membrane bound organelles.",
          ],
        },
        {
          heading: "Organelles",
          lines: [
            "The mitochondria generate ATP for cellular work.",
            "The ribosomes assemble proteins from messenger RNA.",
          ],
        },
      ],
    },
    {
      title: "Cell Biology Notes",
      sections: [
        {
          heading: "The Nucleus",
          lines: [
            "The nucleus stores genetic material in chromosomes.",
            "The nuclear envelope has pores that control what enters and leaves.",
            "Nucleoli produce the subunits that make up ribosomes.",
          ],
        },
      ],
    },
  ],
  "algebra-functions.pdf": [
    {
      title: "Algebra Functions",
      sections: [
        {
          heading: "Linear Functions",
          lines: [
            "A linear function has the form y equals mx plus b.",
            "The slope m describes how steep the line is.",
            "The intercept b is where the line crosses the y axis.",
          ],
        },
        {
          heading: "Quadratic Functions",
          lines: [
            "A quadratic function has the form y equals a x squared plus b x plus c.",
            "Its graph is a parabola that opens upward when a is positive.",
            "The vertex is the highest or lowest point of the curve.",
          ],
        },
      ],
    },
  ],
  "history-ww1-chapter.pdf": [
    {
      title: "The First World War",
      sections: [
        {
          heading: "Causes of the War",
          lines: [
            "The war began in the summer of 1914 after a series of alliances failed.",
            "Nationalism and imperial rivalry had built tension for decades.",
            "The assassination of Archduke Franz Ferdinand was the spark.",
          ],
        },
      ],
    },
    {
      title: "The First World War",
      sections: [
        {
          heading: "The Western Front",
          lines: [
            "Trench warfare stretched from the North Sea to the Swiss border.",
            "Machine guns and artillery made frontal attacks extremely costly.",
            "Soldiers endured mud, cold, and the constant threat of gas.",
          ],
        },
      ],
    },
    {
      title: "The First World War",
      sections: [
        {
          heading: "The Armistice",
          lines: [
            "The fighting stopped on 11 November 1918.",
            "The armistice came after the German leadership collapsed.",
          ],
        },
      ],
    },
    {
      title: "The First World War",
      sections: [
        {
          lines: [
            "The Treaty of Versailles was signed in 1919.",
            "It imposed heavy reparations on Germany and redrew the map of Europe.",
            "Many historians see the settlement as a cause of the next war.",
          ],
        },
      ],
    },
  ],
  "physics-formula-sheet.pdf": [
    {
      title: "Physics Formula Sheet",
      sections: [
        {
          heading: "Mechanics",
          lines: [
            "Force equals mass times acceleration.",
            "Kinetic energy is half times mass times velocity squared.",
            "Gravitational potential energy equals mass times gravity times height.",
          ],
        },
      ],
    },
  ],
  "chemistry-lab-manual.pdf": [
    {
      title: "Chemistry Lab Manual",
      sections: [
        {
          heading: "Safety",
          lines: [
            "Wear safety goggles and gloves at all times in the lab.",
            "Never taste chemicals and always label your samples.",
            "Report spills to the instructor immediately.",
          ],
        },
      ],
    },
    {
      title: "Chemistry Lab Manual",
      sections: [
        {
          heading: "Titration Procedure",
          lines: [
            "Titration is used to determine an unknown concentration.",
            "Add the titrant slowly from the burette until the color changes.",
            "Repeat the run three times and average the volumes used.",
          ],
        },
      ],
    },
  ],
  "long-readings-chapter.pdf": [
    {
      title: "Photosynthesis in Plants",
      sections: [
        {
          heading: "Overview",
          lines: [
            "Plants capture light energy and store it as chemical energy.",
            "Photosynthesis powers nearly all life on Earth.",
            "It releases oxygen into the atmosphere.",
          ],
        },
      ],
    },
    {
      title: "Photosynthesis in Plants",
      sections: [
        {
          heading: "Light Absorption",
          lines: [
            "Chlorophyll absorbs mostly red and blue light.",
            "Accessory pigments broaden the range of usable wavelengths.",
          ],
        },
      ],
    },
    {
      title: "Photosynthesis in Plants",
      sections: [
        {
          heading: "Light Reactions",
          lines: [
            "Light energy drives the transfer of electrons along a chain.",
            "The energy is stored as ATP and NADPH for later use.",
          ],
        },
      ],
    },
    {
      title: "Photosynthesis in Plants",
      sections: [
        {
          heading: "Calvin Cycle",
          lines: [
            "The Calvin cycle fixes carbon dioxide into sugar.",
            "It runs in the stroma of the chloroplast.",
          ],
        },
      ],
    },
    {
      title: "Photosynthesis in Plants",
      sections: [
        {
          heading: "Photolysis",
          lines: [
            "Water is split during photolysis releasing oxygen.",
            "The electrons from water replace those lost from the reaction centre.",
          ],
        },
      ],
    },
    {
      title: "Photosynthesis in Plants",
      sections: [
        {
          heading: "Limiting Factors",
          lines: [
            "Light intensity, temperature and carbon dioxide all limit the rate.",
            "A farmer can raise yield by raising the most limiting factor.",
          ],
        },
      ],
    },
    {
      title: "Photosynthesis in Plants",
      sections: [
        {
          lines: [
            "Net photosynthesis stops when the lights are turned off.",
            "At night respiration uses the stored sugars for energy.",
          ],
        },
      ],
    },
    {
      title: "Photosynthesis in Plants",
      sections: [
        {
          lines: [
            "Net productivity depends on light intensity and temperature.",
            "Above a certain temperature enzymes denature and output drops.",
          ],
        },
      ],
    },
  ],
};

const DOCX_CONTENT: Record<
  string,
  {
    title: string;
    intro: string[];
    sections: { heading: string; level: number; lines: string[] }[];
  }
> = {
  "literature-notes.docx": {
    title: "Romeo and Juliet",
    intro: ["This study guide covers the play Romeo and Juliet by William Shakespeare."],
    sections: [
      {
        heading: "Themes",
        level: 1,
        lines: [
          "The play explores love and fate in equal measure.",
          "Love is portrayed as both tender and destructive.",
        ],
      },
      {
        heading: "Love",
        level: 2,
        lines: [
          "Romeo and Juliet fall in love at first sight.",
          "Their love challenges the feud between their families.",
        ],
      },
    ],
  },
  "geography-study-guide.docx": {
    title: "Geography Study Guide",
    intro: [],
    sections: [
      {
        heading: "Rivers",
        level: 1,
        lines: [
          "A river erodes its channel and carries sediment downstream.",
          "Meanders form where the flow slows and deposits material.",
        ],
      },
      {
        heading: "Coasts",
        level: 1,
        lines: [
          "Waves shape cliffs through erosion and build beaches through deposition.",
          "Longshore drift moves sediment along the shoreline.",
        ],
      },
      {
        heading: "Glaciers",
        level: 1,
        lines: [
          "Glaciers carve U shaped valleys and deposit moraine.",
          "Meltwater forms braided streams at the glacier front.",
        ],
      },
    ],
  },
  "computer-science-basics.docx": {
    title: "Computer Science Basics",
    intro: [],
    sections: [
      {
        heading: "Algorithms",
        level: 1,
        lines: [
          "An algorithm is a finite sequence of well-defined steps.",
          "Good algorithms are efficient in both time and space.",
        ],
      },
      {
        heading: "Data Structures",
        level: 1,
        lines: [
          "Arrays store elements at contiguous memory locations.",
          "Linked lists grow and shrink without copying the whole structure.",
        ],
      },
      {
        heading: "Complexity",
        level: 1,
        lines: [
          "Big O notation describes how work grows with input size.",
          "A linear search is O of n while a binary search is O of log n.",
        ],
      },
    ],
  },
  "mathematics-calculus.docx": {
    title: "Calculus Notes",
    intro: [],
    sections: [
      {
        heading: "Differentiation",
        level: 1,
        lines: [
          "The derivative measures the rate of change of a function.",
          "It is the slope of the tangent line at a point.",
        ],
      },
      {
        heading: "The Derivative",
        level: 2,
        lines: [
          "Notation includes f prime of x and dy over dx.",
          "The chain rule differentiates composed functions.",
        ],
      },
    ],
  },
  "history-notes.docx": {
    title: "History Notes",
    intro: [],
    sections: [
      {
        heading: "The Enlightenment",
        level: 1,
        lines: [
          "Philosophers argued for reason and individual rights.",
          "Writers such as Voltaire challenged the authority of the church.",
        ],
      },
      {
        heading: "Revolutions",
        level: 1,
        lines: [
          "The American revolution established a republic on new principles.",
          "The French revolution spread the ideals of liberty and equality.",
        ],
      },
    ],
  },
  "long-study-guide.docx": {
    title: "Biology Study Guide",
    intro: [],
    sections: [
      {
        heading: "Introduction",
        level: 1,
        lines: [
          Array.from(
            { length: 20 },
            (_, index) =>
              `The mitochondria are often described as the powerhouse of the cell in paragraph ${index + 1}.`,
          ).join(" "),
        ],
      },
      {
        heading: "Detailed Analysis",
        level: 1,
        lines: [
          Array.from(
            { length: 25 },
            (_, index) =>
              `Respiration releases the chemical energy stored in glucose step ${index + 1}.`,
          ).join(" "),
        ],
      },
    ],
  },
};

// ---- Corrupt / unsupported --------------------------------------------------------------------

const CORRUPT: Record<string, Uint8Array> = {
  "corrupt-not-a-pdf.pdf": Buffer.from(
    "This file claims to be a PDF but is actually plain text.",
    "utf8",
  ),
  "corrupt-empty.pdf": Buffer.alloc(0),
  "corrupt-not-a-docx.docx": Buffer.from("definitely not a zip archive", "utf8"),
  "corrupt-empty.docx": Buffer.alloc(0),
  "unsupported-legacy-doc.doc": Buffer.from("fake legacy binary document", "utf8"),
};

// ---- Run --------------------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(FILES_DIR, { recursive: true });

  for (const spec of FIXTURES) {
    if (spec.kind === "pdf") {
      const pageSpecs = PDF_PAGES[spec.file];
      if (!pageSpecs) throw new Error(`Missing PDF content for ${spec.file}`);
      const bytes = await buildPdf(pageSpecs);
      if (spec.pages !== pageSpecs.length) {
        throw new Error(`Manifest page count for ${spec.file} does not match its content`);
      }
      writeFileSync(join(FILES_DIR, spec.file), bytes);
    } else if (spec.kind === "docx") {
      const content = DOCX_CONTENT[spec.file];
      if (!content) throw new Error(`Missing DOCX content for ${spec.file}`);
      writeFileSync(
        join(FILES_DIR, spec.file),
        await buildDocx(content.title, content.intro, content.sections),
      );
    } else if (spec.kind === "corrupt") {
      let bytes: Uint8Array | undefined = CORRUPT[spec.file];
      if (spec.file === "corrupt-truncated-pdf.pdf") {
        const full = await buildPdf(PDF_PAGES["algebra-functions.pdf"]!);
        bytes = full.slice(0, Math.floor(full.byteLength / 2));
      } else if (spec.file === "corrupt-docx-missing-part.docx") {
        const zip = new JSZip();
        zip.file("[Content_Types].xml", CONTENT_TYPES_XML);
        zip.file("_rels/.rels", RELS_XML);
        bytes = await zip.generateAsync({ type: "nodebuffer" });
      }
      if (bytes === undefined) throw new Error(`Missing corrupt content for ${spec.file}`);
      writeFileSync(join(FILES_DIR, spec.file), bytes);
    } else if (spec.kind === "unsupported") {
      const bytes = CORRUPT[spec.file];
      if (bytes === undefined) throw new Error(`Missing unsupported content for ${spec.file}`);
      writeFileSync(join(FILES_DIR, spec.file), bytes);
    }
    console.log(`wrote ${spec.file}`);
  }

  for (const spec of FIXTURES) {
    const path = join(FILES_DIR, spec.file);
    if (!existsSync(path)) throw new Error(`Missing fixture file: ${spec.file}`);
  }
  console.log(`generated ${FIXTURES.length} fixtures in ${FILES_DIR}`);
}

await main();
