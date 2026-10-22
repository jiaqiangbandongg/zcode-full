import { DOC_KINDS, extensionList, joinList, type DocKind } from "#office/contract.ts";
import { PROFILE } from "#office/profile.ts";

/**
 * Model-facing wording that names formats, limited to the formats this plugin opens. Each list
 * keeps one order for every plugin: Word, Excel, PowerPoint, PDF.
 */
const pick = (items: [DocKind, string][]) =>
  items.filter(([kind]) => DOC_KINDS.includes(kind)).map(([, text]) => text);
const FORMAT_NAMES = { docx: "Word", xlsx: "Excel", pptx: "PowerPoint", pdf: "PDF" } as const;
const officeKinds = DOC_KINDS.filter((kind) => kind !== "pdf");
/** "Office" when the plugin opens all three Office formats, else their own names; then "PDF". */
const families = [
  ...(officeKinds.length === 3 ? ["Office"] : officeKinds.map((kind) => FORMAT_NAMES[kind])),
  ...(DOC_KINDS.includes("pdf") ? ["PDF"] : []),
];

export const TITLE = PROFILE.title.en;

/** "an Office or PDF file", "a PDF file", "an Excel file". */
export const FILE_NOUN = (() => {
  const words = joinList(families, "en", "or");
  return `${/^[AEIOU]/.test(words) ? "an" : "a"} ${words} file`;
})();

/** "Office and PDF files", "PDF files", "Excel files". */
export const FILES_NOUN = `${joinList(families)} files`;

/** ".docx, .xlsx, .pptx or .pdf". */
export const EXTENSIONS_OR = extensionList("en", "or");

/** "report.docx#p:12, model.xlsx#Revenue!B2:F9, deck.pptx#slide:3, paper.pdf#page:5". */
export const EXAMPLE_ANCHORS = pick([
  ["docx", "report.docx#p:12"],
  ["xlsx", "model.xlsx#Revenue!B2:F9"],
  ["pptx", "deck.pptx#slide:3"],
  ["pdf", "paper.pdf#page:5"],
]).join(", ");

/** "p:12, slide:3, page:5, Revenue!B2:F9". */
export const EXAMPLE_LOCATIONS = pick([
  ["docx", "p:12"],
  ["pptx", "slide:3"],
  ["pdf", "page:5"],
  ["xlsx", "Revenue!B2:F9"],
]).join(", ");

/** What read_document returns for each format. */
export const READ_FORMS = pick([
  ["docx", "Word paragraphs and tables (markdown)"],
  ["xlsx", "spreadsheet cells as a grid with formulas"],
  ["pptx", "slides with their shapes and speaker notes"],
  ["pdf", "PDF page text"],
]).join(", ");

/** "paragraph, cell range, slide, shape or page". */
export const TARGET_NOUNS = joinList(
  pick([
    ["docx", "paragraph"],
    ["xlsx", "cell range"],
    ["pptx", "slide"],
    ["pptx", "shape"],
    ["pdf", "page"],
  ]),
  "en",
  "or",
);

/** "PDF pages and long paragraphs". */
export const QUOTE_BEST_FOR =
  joinList(
    pick([
      ["pdf", "PDF pages"],
      ["docx", "long paragraphs"],
    ]),
  ) || "long passages";

/** capture_view examples: "deck.pptx#slide:3, paper.pdf#page:2, report.docx#p:12 or model.xlsx#Revenue!A1:H30". */
export const CAPTURE_EXAMPLES = joinList(
  pick([
    ["pptx", "deck.pptx#slide:3"],
    ["pdf", "paper.pdf#page:2"],
    ["docx", "report.docx#p:12"],
    ["xlsx", "model.xlsx#Revenue!A1:H30"],
  ]),
  "en",
  "or",
);
