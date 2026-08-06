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
import { createRequire } from "node:module";
import { join } from "node:path";

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { FIXTURES } from "./specs";

const require = createRequire(import.meta.url);

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

// ---- Rasters (OCR fixtures) -------------------------------------------------------------------

// The clean English page. Rendered 800x220 at 48px, two short lines — the exact geometry verified
// (ADR 0007) to OCR back at mean per-word confidence >= 95 with the committed eng.traineddata.
const RASTER_ENG_LINES = [
  "Plants use photosynthesis to make food",
  "Chlorophyll gives leaves their green color",
];

// Arabic line rendered with the checked-in Noto Sans Arabic face; recognized at confidence >= 85 by
// the candidate-language pass in eng -> spa -> ara order.
const RASTER_ARA_LINE = "التمثيل الضوئي يحول الضوء إلى طاقة";

const ARABIC_FONT = "NotoArabic";

// Register the Arabic face from the checked-in @fontsource package. Raster generation is
// deterministic — no random content, and the exact face is committed — so regeneration reproduces
// byte-for-byte what tests OCR against.
if (
  !GlobalFonts.registerFromPath(
    require.resolve("@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff"),
    ARABIC_FONT,
  )
) {
  throw new Error("could not register the Noto Sans Arabic font for raster fixtures");
}

function renderRaster(
  lines: string[],
  options: { font?: string; height?: number; rotate?: boolean } = {},
): Buffer {
  const width = 800;
  const height = options.height ?? 220;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "black";
  ctx.font = options.font ?? "48px sans-serif";
  lines.forEach((line, index) => ctx.fillText(line, 20, 90 + index * 70));

  if (options.rotate) {
    // Rotate the whole canvas 90 degrees clockwise so tesseract reads the text as non-text; this
    // is the low-confidence fixture, its confidence stays well under the flagging threshold.
    const rotated = createCanvas(height, width);
    const rctx = rotated.getContext("2d");
    rctx.translate(height, 0);
    rctx.rotate(Math.PI / 2);
    rctx.drawImage(canvas, 0, 0);
    return rotated.toBuffer("image/png");
  }
  return canvas.toBuffer("image/png");
}

/** The committed raster content, keyed by fixture file name. */
const RASTER_CONTENT: Record<string, Buffer> = {
  "photosynthesis-notes.png": renderRaster(RASTER_ENG_LINES),
  "arabic-photosynthesis-notes.png": renderRaster([RASTER_ARA_LINE], {
    font: `52px ${ARABIC_FONT}`,
  }),
  "scanned-rotated-notes.png": renderRaster(
    [...RASTER_ENG_LINES, "Oxygen is released during the process"],
    {
      height: 280,
      rotate: true,
    },
  ),
};

// ---- Scanned PDF -------------------------------------------------------------------------------

/**
 * A PDF with no text layer: one page whose only content is an embedded raster. `extractTextItems`
 * finds nothing, so parsing exercises the OCR fallback in parsers/pdf.ts.
 *
 * The page is sized to the raster (800x220pt) and the raster drawn 1:1, so rendering it back at
 * scale 2 produces the same glyphs at twice the resolution as the source PNG — which is what keeps
 * the OCR confidence on this fixture in the same >= 95 range as the raster itself. Stretching the
 * image to a letterbox page (as a real scan would) distorts letters and OCR conf drops.
 */
async function buildScannedPdf(pngBytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([800, 220]);
  const image = await pdf.embedPng(pngBytes);
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: 800,
    height: 220,
  });
  const bytes = await pdf.save();
  const reloaded = await PDFDocument.load(bytes);
  if (reloaded.getPageCount() !== 1) throw new Error("scanned PDF must have exactly one page");
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

// ---- PPTX ------------------------------------------------------------------------------------

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const OFFICE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

interface PptxSlide {
  /** The slide's title placeholder text, or null for a title-less slide. */
  title: string | null;
  bullets: string[];
  /** The speaker notes, when the slide has a notes part. */
  notes?: string;
}

const PPTX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${OFFICE_REL_TYPE}/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

const pptxContentTypes = (
  overrides: string,
): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${overrides}
</Types>`;

const presentationXml = (
  slideCount: number,
): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">
  <p:sldIdLst>${Array.from(
    { length: slideCount },
    (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`,
  ).join("")}</p:sldIdLst>
</p:presentation>`;

const presentationRelsXml = (
  slideCount: number,
): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${Array.from(
    { length: slideCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="${OFFICE_REL_TYPE}/slide" Target="slides/slide${index + 1}.xml"/>`,
  ).join("\n  ")}
</Relationships>`;

const slideXml = (slide: PptxSlide, id: number): string => {
  const titleShape =
    slide.title === null
      ? ""
      : `<p:sp>
      <p:nvSpPr>
        <p:cNvPr id="${id}" name="Title ${id}"/>
        <p:cNvSpPr/>
        <p:nvPr><p:ph type="title"/></p:nvPr>
      </p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>${escapeXml(slide.title)}</a:t></a:r></a:p></p:txBody>
    </p:sp>`;
  const bodyShape = slide.bullets
    .map(
      (bullet) => `<p:sp>
      <p:nvSpPr>
        <p:cNvPr id="${id}" name="Content Placeholder ${id}"/>
        <p:cNvSpPr/>
        <p:nvPr><p:ph type="body" idx="1"/></p:nvPr>
      </p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>${escapeXml(bullet)}</a:t></a:r></a:p></p:txBody>
    </p:sp>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="${id}" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
      ${titleShape}
      ${bodyShape}
    </p:spTree>
  </p:cSld>
</p:sld>`;
};

const notesXml = (notes: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Notes Placeholder 2"/>
          <p:cNvSpPr/>
          <p:nvPr><p:ph type="body" idx="1"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr/>
        <p:txBody><a:bodyPr/><a:p><a:r><a:t>${escapeXml(notes)}</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:notes>`;

const slideRelsXml = (
  notesSlideNumber: number | null,
): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${OFFICE_REL_TYPE}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  ${
    notesSlideNumber === null
      ? ""
      : `<Relationship Id="rId2" Type="${OFFICE_REL_TYPE}/notesSlide" Target="../notesSlides/notesSlide${notesSlideNumber}.xml"/>`
  }
</Relationships>`;

async function buildPptx(slides: PptxSlide[]): Promise<Buffer> {
  const zip = new JSZip();
  const overrides = [
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
  ];
  slides.forEach((slide, index) => {
    const n = index + 1;
    overrides.push(
      `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    );
    if (slide.notes !== undefined) {
      overrides.push(
        `<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
      );
    }
  });
  zip.file("[Content_Types].xml", pptxContentTypes(overrides.join("\n  ")));
  zip.file("_rels/.rels", PPTX_ROOT_RELS);
  zip.file("ppt/presentation.xml", presentationXml(slides.length));
  zip.file("ppt/_rels/presentation.xml.rels", presentationRelsXml(slides.length));
  slides.forEach((slide, index) => {
    const n = index + 1;
    zip.file(`ppt/slides/slide${n}.xml`, slideXml(slide, 1 + n * 10));
    zip.file(
      `ppt/slides/_rels/slide${n}.xml.rels`,
      slideRelsXml(slide.notes !== undefined ? n : null),
    );
    if (slide.notes !== undefined) {
      zip.file(`ppt/notesSlides/notesSlide${n}.xml`, notesXml(slide.notes));
    }
  });
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

const PPTX_DECKS: Record<string, PptxSlide[]> = {
  "photosynthesis-deck.pptx": [
    {
      title: "Photosynthesis",
      bullets: [
        "Photosynthesis converts light energy into chemical energy stored in glucose.",
        "It happens in the chloroplasts of plant cells.",
      ],
      notes: "Opening slide: connect the reaction to the big picture.",
    },
    {
      title: "Light Reactions",
      bullets: [
        "Chlorophyll absorbs mostly red and blue light.",
        "Light energy splits water molecules during photolysis.",
      ],
    },
    {
      title: "The Calvin Cycle",
      bullets: [
        "The Calvin cycle fixes carbon dioxide into organic molecules.",
        "It uses ATP and NADPH produced in the light reactions.",
      ],
      notes: "Emphasize that the cycle repeats three times.",
    },
  ],
  "solar-system-deck.pptx": [
    {
      title: "The Solar System",
      bullets: [
        "The Sun contains most of the mass of the solar system.",
        "Eight planets orbit the Sun in elliptical paths.",
      ],
      notes: "Introduce the scale of distances between the planets.",
    },
    {
      title: null,
      bullets: [
        "Jupiter is the largest planet by mass.",
        "Saturn's rings are made of ice and rock.",
        "Neptune was discovered by calculation before observation.",
      ],
      notes: "Cover the gas giants and how each was found.",
    },
  ],
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
  "corrupt-not-a-pptx.pptx": Buffer.from(
    "This file claims to be a PPTX but is actually plain text.",
    "utf8",
  ),
  "corrupt-empty.pptx": Buffer.alloc(0),
  "unsupported-legacy-doc.doc": Buffer.from("fake legacy binary document", "utf8"),
  "unsupported-legacy-ppt.ppt": Buffer.from("fake legacy binary presentation", "utf8"),
};

// ---- Run --------------------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(FILES_DIR, { recursive: true });

  for (const spec of FIXTURES) {
    if (spec.kind === "pdf") {
      if (spec.file === "scanned-photosynthesis-guide.pdf") {
        const bytes = await buildScannedPdf(RASTER_CONTENT["photosynthesis-notes.png"]!);
        if (spec.pages !== 1) {
          throw new Error(`Manifest page count for ${spec.file} does not match its content`);
        }
        writeFileSync(join(FILES_DIR, spec.file), bytes);
      } else {
        const pageSpecs = PDF_PAGES[spec.file];
        if (!pageSpecs) throw new Error(`Missing PDF content for ${spec.file}`);
        const bytes = await buildPdf(pageSpecs);
        if (spec.pages !== pageSpecs.length) {
          throw new Error(`Manifest page count for ${spec.file} does not match its content`);
        }
        writeFileSync(join(FILES_DIR, spec.file), bytes);
      }
    } else if (spec.kind === "image") {
      const bytes = RASTER_CONTENT[spec.file];
      if (!bytes) throw new Error(`Missing raster content for ${spec.file}`);
      writeFileSync(join(FILES_DIR, spec.file), bytes);
    } else if (spec.kind === "docx") {
      const content = DOCX_CONTENT[spec.file];
      if (!content) throw new Error(`Missing DOCX content for ${spec.file}`);
      writeFileSync(
        join(FILES_DIR, spec.file),
        await buildDocx(content.title, content.intro, content.sections),
      );
    } else if (spec.kind === "pptx") {
      const deck = PPTX_DECKS[spec.file];
      if (!deck) throw new Error(`Missing PPTX content for ${spec.file}`);
      if (spec.slides !== deck.length) {
        throw new Error(`Manifest slide count for ${spec.file} does not match its content`);
      }
      writeFileSync(join(FILES_DIR, spec.file), await buildPptx(deck));
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
      } else if (spec.file === "corrupt-pptx-missing-presentation.pptx") {
        const zip = new JSZip();
        zip.file("[Content_Types].xml", pptxContentTypes(""));
        zip.file("_rels/.rels", PPTX_ROOT_RELS);
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
