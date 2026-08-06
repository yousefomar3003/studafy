import { posix } from "node:path";

import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";

import { CorruptDocumentError, EmptyDocumentError } from "../errors";

import type { ParsedBlock, ParsedDocument } from "../types";

/**
 * PPTX is OOXML, a zip of XML parts, so there is no dedicated extraction library to shell out to —
 * the format's text model (`a:p` paragraphs of `a:r` runs of `a:t` text) is simple enough to read
 * directly and gives exact control over text order, which is the point of this parser.
 *
 * The parts we touch, and why:
 *   - `ppt/presentation.xml` + `ppt/_rels/presentation.xml.rels`: the `p:sldIdLst` is the deck's
 *     presentation order, resolved to slide parts through the relationships. Slide *numbers* are the
 *     anchors for the chunker, so this order is authoritative, not the slide part filenames.
 *   - `ppt/slides/slideN.xml`: the shape tree (`p:spTree`). We walk every `a:p` in document order —
 *     through `p:sp`, `p:grpSp` groups and `p:graphicFrame` tables alike — which is what "embedded
 *     text order preserved" means. The shape whose placeholder declares `type="title"` supplies the
 *     slide's heading; real placeholder semantics, not a font-size guess.
 *   - `ppt/slides/_rels/slideN.xml.rels` → the notesSlide part: the speaker notes, which belong to
 *     their slide's chunk. The notes part's filename says nothing about which slide it serves, so
 *     the relationship is the only reliable mapping.
 *
 * Nothing here reaches the filesystem or spawns processes; like the PDF and DOCX parsers it is pure
 * in-process library work.
 */

/** One slide of the deck in presentation order. `path` is the slide part's zip path. */
interface SlidePart {
  number: number;
  path: string;
}

export async function parsePptx(bytes: Uint8Array): Promise<ParsedDocument> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new CorruptDocumentError("file is not a valid PPTX");
  }

  const presentation = parsePart(await readPart(zip, "ppt/presentation.xml"));
  const presentationRels = parsePart(await readPart(zip, "ppt/_rels/presentation.xml.rels"));
  const slides = slideParts(presentation, presentationRels);

  const blocks: ParsedBlock[] = [];
  for (const slide of slides) {
    const slideDoc = parsePart(await readPart(zip, slide.path));
    const { title, body } = extractSlide(slideDoc);
    const notes = await notesText(zip, slide.path);
    pushSlideBlocks(blocks, slide.number, title, body, notes);
  }

  if (blocks.length === 0) {
    throw new EmptyDocumentError("no extractable text");
  }
  return { format: "pptx", pages: slides.length, blocks, ocrReport: null };
}

/**
 * The deck's slides in presentation order, numbered 1-based.
 *
 * A `p:sldId` references a slide part by relationship id; a deck whose presentation references a
 * slide it cannot resolve is corrupt, and every slide's text is a loss the pipeline must not paper
 * over with a partial extraction.
 */
function slideParts(presentation: XmlDocument, rels: XmlDocument): SlidePart[] {
  const slidesById = new Map<string, string>();
  for (const relationship of Array.from(rels.getElementsByTagNameNS(REL_NS, "Relationship"))) {
    const id = relationship.getAttribute("Id");
    const type = relationship.getAttribute("Type") ?? "";
    const target = relationship.getAttribute("Target");
    if (id !== null && target !== null && type.endsWith(SLIDE_REL_TYPE_SUFFIX)) {
      slidesById.set(id, resolvePartPath("ppt", target));
    }
  }

  const slides: SlidePart[] = [];
  for (const slideId of Array.from(presentation.getElementsByTagNameNS(P_NS, "sldId"))) {
    const relId = slideId.getAttributeNS(R_NS, "id");
    const path = relId === null ? undefined : slidesById.get(relId);
    if (path === undefined) throw new CorruptDocumentError("file is not a valid PPTX");
    slides.push({ number: slides.length + 1, path });
  }
  return slides;
}

/** The slide's heading and its body paragraphs in reading order. The title paragraph is never body. */
function extractSlide(doc: XmlDocument): { title: string | null; body: string[] } {
  const shapeTree = doc.getElementsByTagNameNS(P_NS, "spTree")[0];
  if (!shapeTree) return { title: null, body: [] };

  const titleShape = findTitleShape(shapeTree);
  const titleParagraphs = titleShape
    ? new Set(Array.from(titleShape.getElementsByTagNameNS(A_NS, "p")))
    : new Set<XmlElement>();

  let title: string | null = null;
  const body: string[] = [];
  for (const paragraph of Array.from(shapeTree.getElementsByTagNameNS(A_NS, "p"))) {
    const text = paragraphText(paragraph);
    if (text === "") continue;
    if (titleParagraphs.has(paragraph)) {
      if (title === null) title = text;
    } else {
      body.push(text);
    }
  }
  return { title, body };
}

/** The first shape whose placeholder declares itself a title, or null when the slide has no title. */
function findTitleShape(shapeTree: XmlElement): XmlElement | null {
  for (const shape of Array.from(shapeTree.getElementsByTagNameNS(P_NS, "sp"))) {
    const placeholder = shape.getElementsByTagNameNS(P_NS, "ph")[0];
    if (!placeholder) continue;
    const type = placeholder.getAttribute("type");
    if (type === "title" || type === "ctrTitle") return shape;
  }
  return null;
}

/**
 * The speaker notes of a slide, or an empty list when the slide has none.
 *
 * Notes are supplementary, so every failure here is swallowed: a deck whose notes part is missing
 * or unreadable still ingests its slides. Only slide content is structurally required.
 */
async function notesText(zip: JSZip, slidePath: string): Promise<string[]> {
  const relsPath = posix.join(
    posix.dirname(slidePath),
    "_rels",
    `${posix.basename(slidePath)}.rels`,
  );
  const relsEntry = zip.file(relsPath);
  if (!relsEntry) return [];

  let rels: XmlDocument;
  try {
    rels = parseXml(await relsEntry.async("string"));
  } catch {
    return [];
  }

  let target: string | null = null;
  for (const relationship of Array.from(rels.getElementsByTagNameNS(REL_NS, "Relationship"))) {
    const type = relationship.getAttribute("Type") ?? "";
    const candidate = relationship.getAttribute("Target");
    if (type.endsWith(NOTES_REL_TYPE_SUFFIX) && candidate !== null) {
      target = candidate;
      break;
    }
  }
  if (target === null) return [];

  const notesEntry = zip.file(resolvePartPath(posix.dirname(slidePath), target));
  if (!notesEntry) return [];
  try {
    return paragraphTexts(parseXml(await notesEntry.async("string")));
  } catch {
    return [];
  }
}

/** Every non-empty paragraph of a notes part, in reading order. */
function paragraphTexts(doc: XmlDocument): string[] {
  const shapeTree = doc.getElementsByTagNameNS(P_NS, "spTree")[0];
  if (!shapeTree) return [];
  const texts: string[] = [];
  for (const paragraph of Array.from(shapeTree.getElementsByTagNameNS(A_NS, "p"))) {
    const text = paragraphText(paragraph);
    if (text !== "") texts.push(text);
  }
  return texts;
}

/** One paragraph's text: its runs and fields in order, with `a:br` line breaks intact. */
function paragraphText(paragraph: XmlElement): string {
  let text = "";
  for (const node of Array.from(paragraph.childNodes)) {
    if (node.nodeType !== 1) continue;
    const element = node as XmlElement;
    if (element.namespaceURI !== A_NS) continue;
    if (element.localName === "br") text += "\n";
    else if (element.localName === "r") text += runText(element);
    else if (element.localName === "t") text += element.textContent ?? "";
    else if (element.localName === "fld") text += paragraphText(element);
  }
  return text.trim();
}

/** A run's text: its `a:t` children concatenated, ignoring the run properties. */
function runText(run: XmlElement): string {
  let text = "";
  for (const node of Array.from(run.childNodes)) {
    if (node.nodeType !== 1) continue;
    const element = node as XmlElement;
    if (element.namespaceURI === A_NS && element.localName === "t") {
      text += element.textContent ?? "";
    }
  }
  return text;
}

function pushSlideBlocks(
  blocks: ParsedBlock[],
  slideNumber: number,
  title: string | null,
  body: string[],
  notes: string[],
): void {
  const push = (text: string, kind: "heading" | "body"): void => {
    blocks.push({ text, kind, pageNumber: slideNumber, slideNumber });
  };
  if (title !== null) push(title, "heading");
  for (const paragraph of body) push(paragraph, "body");
  for (const note of notes) push(note, "body");
}

/** A slide part that must exist for the deck to be well-formed. */
async function readPart(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path);
  if (!entry) throw new CorruptDocumentError("file is not a valid PPTX");
  return entry.async("string");
}

/** Resolve a relationship target against its part's directory, e.g. `../notesSlides/x.xml`. */
function resolvePartPath(baseDir: string, target: string): string {
  // `posix.resolve` anchors relative arguments on the process cwd, so pin the root explicitly to
  // keep zip-relative resolution independent of where the worker runs.
  return posix.resolve("/", baseDir, target).slice(1);
}

// ---- XML --------------------------------------------------------------------------------------

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const SLIDE_REL_TYPE_SUFFIX = "/slide";
const NOTES_REL_TYPE_SUFFIX = "/notesSlide";

/**
 * The slice of the DOM API the walker uses. `@xmldom/xmldom` nodes satisfy it structurally; typing
 * against these minimal shapes keeps the parser independent of the DOM lib and any ambient types.
 */
interface XmlNode {
  nodeType: number;
  localName: string | null;
  namespaceURI: string | null;
  textContent: string | null;
  childNodes: XmlNode[];
}

interface XmlElement extends XmlNode {
  getElementsByTagNameNS(namespace: string, localName: string): XmlElement[];
  getAttribute(name: string): string | null;
  getAttributeNS(namespace: string, name: string): string | null;
}

interface XmlDocument {
  getElementsByTagNameNS(namespace: string, localName: string): XmlElement[];
}

/**
 * Well-formed part XML is the norm; anything else is a corrupt file. Recoverable parser errors
 * (e.g. an undeclared entity) are dropped so a hostile part cannot spam the worker logs; fatal
 * errors (malformed markup) rethrow and become `CorruptDocumentError` at the call site.
 */
const ignoreXmlError = (): void => undefined;
const parser = new DOMParser({
  errorHandler: {
    warning: ignoreXmlError,
    error: ignoreXmlError,
    fatalError(error) {
      throw error instanceof Error ? error : new Error(String(error));
    },
  },
});

function parseXml(source: string): XmlDocument {
  return parser.parseFromString(source, "application/xml") as unknown as XmlDocument;
}

/** Structural parts must parse; a deck whose core XML is malformed is corrupt. */
function parsePart(source: string): XmlDocument {
  try {
    return parseXml(source);
  } catch {
    throw new CorruptDocumentError("file is not a valid PPTX");
  }
}
