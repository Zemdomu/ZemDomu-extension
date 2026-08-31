import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";

import { ProjectLinter } from "zemdomu";
import type { ProjectLinterOptions, LintResult } from "zemdomu";

import { PerformanceDiagnostics } from "./performance-diagnostics";
import { IssueTracker } from "./issue-tracker";
import { applyInlineDisableDirectives } from "./linter";

/**
 * Race-safe, queued, and atomic application of diagnostics.
 * - Serializes workspace scans to avoid overlapping clears/applies
 * - Uses runId guards for compute and apply
 * - Avoids diagnostics.clear() upfront; surgically removes stale files
 * - Keeps automatic work aligned with the selected public run-mode contract
 */

type FileCacheEntry = {
  etag: string | null;
  diags: vscode.Diagnostic[];
};

type LintResultWithCode = LintResult & {
  code?: string;
  offset?: number;
  endOffset?: number;
};

type WorkspaceScanProgress = {
  message: string;
  completion: number;
};

type WorkspaceScanOutcome = "completed" | "superseded";

type ProjectGroupProgress = {
  completedGroups: number;
  totalGroups: number;
  currentGroup: number;
  currentGroupFiles: number;
};

const DOCS_BASE_URL = "https://zemdomu.dev/docs/";
const RULE_NAMES = [
  "requireSectionHeading",
  "enforceHeadingOrder",
  "singleH1",
  "requireAltText",
  "requireLabelForFormControls",
  "enforceListNesting",
  "requireLinkText",
  "requireTableCaption",
  "preventEmptyInlineTags",
  "requireHrefOnAnchors",
  "requireButtonText",
  "requireIframeTitle",
  "requireHtmlLang",
  "requireImageInputAlt",
  "requireNavLinks",
  "uniqueIds",
  "noTabindexGreaterThanZero",
  "preventZemdomuPlaceholders",
  "requireDocumentTitle",
  "requireSingleMain",
  "ariaValidAttrValue",
] as const;

const DOCS_RULES = new Set<string>(RULE_NAMES);

const QUICK_FIX_PLACEHOLDER = "TODO-ZMD";

const diagCache = new Map<string, FileCacheEntry>();

// Monotonic run ids to drop stale async results
let globalRunId = 0;

// Simple serialization for workspace-wide runs
let runningWorkspace: Promise<WorkspaceScanOutcome> | null = null;
let workspaceQueued = false;

function queueWorkspace(run: () => Promise<WorkspaceScanOutcome>) {
  if (runningWorkspace) {
    workspaceQueued = true;
    return runningWorkspace;
  }
  runningWorkspace = (async () => {
    try {
      return await run();
    } finally {
      runningWorkspace = null;
      if (workspaceQueued) {
        workspaceQueued = false;
        queueWorkspace(run);
      }
    }
  })();
  return runningWorkspace;
}

// Create a stable signature for a LintResult
function keyLint(r: LintResult): string {
  const located = r as LintResultWithCode;
  const line = Number.isFinite(r.line) ? r.line : 0;
  const col = Number.isFinite(r.column) ? r.column : 0;
  const offset = Number.isFinite(located.offset) ? located.offset : "";
  const endOffset = Number.isFinite(located.endOffset) ? located.endOffset : "";
  return `${r.rule}|${line}|${col}|${offset}|${endOffset}|${r.message}`;
}

// Deterministic ordering makes comparisons stable
function stableSort(results: LintResult[]): LintResult[] {
  return [...results].sort((a, b) => {
    const ka = keyLint(a);
    const kb = keyLint(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function docsUriForRule(rule: string): vscode.Uri | null {
  if (!DOCS_RULES.has(rule)) return null;
  return vscode.Uri.parse(`${DOCS_BASE_URL}${encodeURIComponent(rule)}`);
}

function previewKeys(keys: string[]): string[] {
  if (keys.length <= 6) return keys;
  return [...keys.slice(0, 3), "...", ...keys.slice(-3)];
}

// Cheap etag for open docs: VS Code version; fallback null
function docEtag(doc: vscode.TextDocument | undefined): string | null {
  if (!doc) return null;
  return `${doc.version}`;
}

function codeTargetKey(target: unknown): string | null {
  if (!target) return null;
  if (typeof (target as { toString?: () => string }).toString === "function") {
    return (target as { toString: () => string }).toString();
  }
  if (typeof (target as { path?: string }).path === "string") {
    return (target as { path: string }).path;
  }
  if (typeof (target as { fsPath?: string }).fsPath === "string") {
    return (target as { fsPath: string }).fsPath;
  }
  return String(target);
}

function equalDiagnosticCodes(
  a: vscode.Diagnostic["code"],
  b: vscode.Diagnostic["code"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const aObj = a as { value?: unknown; target?: unknown };
  const bObj = b as { value?: unknown; target?: unknown };
  if (typeof a === "object" && typeof b === "object") {
    return (
      aObj.value === bObj.value &&
      codeTargetKey(aObj.target) === codeTargetKey(bObj.target)
    );
  }
  return false;
}

// Compare two Diagnostic arrays by value
function equalDiagnostics(
  a: vscode.Diagnostic[],
  b: vscode.Diagnostic[]
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i],
      y = b[i];
    if (
      x.message !== y.message ||
      x.severity !== y.severity ||
      !equalDiagnosticCodes(x.code, y.code) ||
      x.range.start.line !== y.range.start.line ||
      x.range.start.character !== y.range.start.character ||
      x.range.end.line !== y.range.end.line ||
      x.range.end.character !== y.range.end.character
    )
      return false;
  }
  return true;
}

function diagnosticCodeValue(
  code: vscode.Diagnostic["code"]
): string | null {
  if (typeof code === "string") return code;
  if (typeof code === "number") return String(code);
  if (code && typeof code === "object") {
    const value = (code as { value?: unknown }).value;
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function isSectionHeadingDiagnostic(diag: vscode.Diagnostic): boolean {
  const code = diagnosticCodeValue(diag.code);
  if (code === "ZMD001" || code === "requireSectionHeading") return true;
  return (
    diag.message.includes("<section>") && diag.message.includes("missing heading")
  );
}

function getIndentUnit(document: vscode.TextDocument): string {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.fsPath === document.uri.fsPath) {
    const tabSize =
      typeof editor.options.tabSize === "number" ? editor.options.tabSize : 2;
    return editor.options.insertSpaces ? " ".repeat(tabSize) : "\t";
  }
  return "  ";
}

function getOffsetAt(
  document: vscode.TextDocument,
  pos: vscode.Position,
  text: string
): number {
  const docWithOffset = document as vscode.TextDocument & {
    offsetAt?: (p: vscode.Position) => number;
  };
  if (typeof docWithOffset.offsetAt === "function") {
    return docWithOffset.offsetAt(pos);
  }
  const newlineLength = text.includes("\r\n") ? 2 : 1;
  const lines = text.split(/\r?\n/);
  let offset = 0;
  for (let i = 0; i < pos.line && i < lines.length; i++) {
    offset += lines[i].length + newlineLength;
  }
  if (pos.line < lines.length) {
    offset += Math.min(pos.character, lines[pos.line].length);
  }
  return Math.min(offset, text.length);
}

function getPositionAt(
  document: vscode.TextDocument,
  offset: number,
  text: string
): vscode.Position {
  const docWithPosition = document as vscode.TextDocument & {
    positionAt?: (o: number) => vscode.Position;
  };
  if (typeof docWithPosition.positionAt === "function") {
    return docWithPosition.positionAt(offset);
  }
  const newlineLength = text.includes("\r\n") ? 2 : 1;
  const lines = text.split(/\r?\n/);
  let remaining = Math.max(0, Math.min(offset, text.length));
  for (let i = 0; i < lines.length; i++) {
    const lineLength = lines[i].length;
    if (remaining <= lineLength) {
      return new vscode.Position(i, remaining);
    }
    remaining -= lineLength + newlineLength;
  }
  const lastLine = Math.max(0, lines.length - 1);
  return new vscode.Position(lastLine, lines[lastLine]?.length ?? 0);
}

function getVueTemplateRange(
  text: string
): { start: number; end: number } | null {
  const startMatch = /<template\b[^>]*>/i.exec(text);
  if (!startMatch) return null;
  const start = startMatch.index + startMatch[0].length;
  const endMatch = /<\/template>/i.exec(text.slice(start));
  if (!endMatch) return null;
  const end = start + endMatch.index;
  return { start, end };
}

function findLastHeadingLevel(text: string): number | null {
  const regex = /<h([1-6])\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  let last: number | null = null;
  while ((match = regex.exec(text))) {
    last = Number(match[1]);
  }
  return last;
}

function chooseSectionHeadingLevel(previous: number | null): number {
  if (!previous) return 2;
  if (previous <= 1) return 2;
  return previous;
}

function parseHeadingOrderMessage(
  message: string
): { current: number; last: number } | null {
  const match = message.match(/<h([1-6])>\s+after\s+<h([1-6])>/i);
  if (!match) return null;
  return { current: Number(match[1]), last: Number(match[2]) };
}

function computeHeadingOrderFixLevel(
  current: number,
  last: number
): number | null {
  if (current === 1 && last !== 1) return last;
  if (current > last + 1) return last + 1;
  if (last > current + 1) return last - 1;
  return null;
}

function isHeadingOrderDiagnostic(diag: vscode.Diagnostic): boolean {
  const code = diagnosticCodeValue(diag.code);
  if (code === "ZMD002" || code === "enforceHeadingOrder") return true;
  return diag.message.includes("Heading level skipped");
}

function isSingleH1Diagnostic(diag: vscode.Diagnostic): boolean {
  const code = diagnosticCodeValue(diag.code);
  if (code === "ZMD003" || code === "singleH1") return true;
  return diag.message.includes("Only one <h1>");
}

function isListNestingDiagnostic(diag: vscode.Diagnostic): boolean {
  const code = diagnosticCodeValue(diag.code);
  if (code === "ZMD006" || code === "enforceListNesting") return true;
  return diag.message.includes("<li> must be inside a <ul> or <ol>");
}

function isNavLinksDiagnostic(diag: vscode.Diagnostic): boolean {
  const code = diagnosticCodeValue(diag.code);
  if (code === "ZMD015" || code === "requireNavLinks") return true;
  return diag.message.includes("<nav> contains no links");
}

function isTabindexDiagnostic(diag: vscode.Diagnostic): boolean {
  const code = diagnosticCodeValue(diag.code);
  if (code === "ZMD017" || code === "noTabindexGreaterThanZero") return true;
  return diag.message.includes("Tabindex greater than 0 should be avoided");
}

function isLinkTextDiagnostic(diag: vscode.Diagnostic): boolean {
  const code = diagnosticCodeValue(diag.code);
  if (code === "ZMD007" || code === "requireLinkText") return true;
  return (
    diag.message.includes("missing accessible name") ||
    diag.message.includes("missing link text")
  );
}

function isDocumentTitleDiagnostic(diag: vscode.Diagnostic): boolean {
  const code = diagnosticCodeValue(diag.code);
  if (code === "ZMD019" || code === "requireDocumentTitle") return true;
  return diag.message.includes("<title>");
}

function isSingleMainDiagnostic(diag: vscode.Diagnostic): boolean {
  const code = diagnosticCodeValue(diag.code);
  if (code === "ZMD020" || code === "requireSingleMain") return true;
  return diag.message.includes("<main>");
}

function isAriaValidAttrValueDiagnostic(diag: vscode.Diagnostic): boolean {
  const code = diagnosticCodeValue(diag.code);
  if (code === "ZMD021" || code === "ariaValidAttrValue") return true;
  return diag.message.startsWith("ARIA attribute ");
}

function parseInvalidAriaValueMessage(
  message: string
): { attr: string } | null {
  const match = message.match(/^ARIA attribute "([^"]+)" has invalid value "[\s\S]*"$/);
  if (!match) return null;
  return { attr: match[1].toLowerCase() };
}

function getAriaQuickFixValue(attr: string): string {
  const BOOLEAN_DEFAULTS = new Set([
    "aria-hidden",
    "aria-expanded",
    "aria-selected",
    "aria-disabled",
    "aria-required",
    "aria-modal",
    "aria-multiline",
    "aria-multiselectable",
    "aria-readonly",
    "aria-busy",
    "aria-atomic",
  ]);
  const TRISTATE_DEFAULTS = new Set(["aria-checked", "aria-pressed"]);
  const NUMERIC_DEFAULTS = new Set([
    "aria-level",
    "aria-valuemin",
    "aria-valuemax",
    "aria-valuenow",
    "aria-colindex",
    "aria-rowindex",
    "aria-colcount",
    "aria-rowcount",
    "aria-setsize",
    "aria-posinset",
  ]);
  const IDREF_LIST_DEFAULTS = new Set([
    "aria-labelledby",
    "aria-describedby",
    "aria-controls",
    "aria-owns",
    "aria-details",
    "aria-errormessage",
    "aria-flowto",
  ]);
  if (BOOLEAN_DEFAULTS.has(attr)) return "false";
  if (TRISTATE_DEFAULTS.has(attr)) return "false";
  if (NUMERIC_DEFAULTS.has(attr)) return "1";
  if (IDREF_LIST_DEFAULTS.has(attr)) return QUICK_FIX_PLACEHOLDER;

  switch (attr) {
    case "aria-current":
      return "page";
    case "aria-live":
      return "polite";
    case "aria-sort":
      return "ascending";
    case "aria-orientation":
      return "vertical";
    case "aria-haspopup":
      return "dialog";
    case "aria-autocomplete":
      return "list";
    case "aria-invalid":
      return "true";
    case "aria-relevant":
      return "additions";
    default:
      return "false";
  }
}

function findTagEnd(text: string, start: number): number | null {
  if (text[start] !== "<") return null;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let braceDepth = 0;
  let escape = false;

  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }

    if (inSingle) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "`") {
        inBacktick = false;
        continue;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === "\"") {
      inDouble = true;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      continue;
    }
    if (ch === "{") {
      braceDepth += 1;
      continue;
    }
    if (ch === "}") {
      if (braceDepth > 0) braceDepth -= 1;
      continue;
    }
    if (ch === ">" && braceDepth === 0) return i;
  }

  return null;
}

type TagInfo = {
  name: string;
  rawName?: string;
  start: number;
  end: number;
  text: string;
};

type ParsedAttr = {
  name: string;
  value: string | null;
  dynamic: boolean;
  nameStart: number;
  nameEnd: number;
  valueStart: number | null;
  valueEnd: number | null;
};

const FORM_CONTROL_TAGS = new Set(["input", "select", "textarea"]);

function findFormControlTag(text: string, offset: number): TagInfo | null {
  const matchTagAt = (idx: number): TagInfo | null => {
    if (text[idx] !== "<") return null;
    if (text.startsWith("</", idx) || text.startsWith("<!--", idx)) return null;
    const match = text.slice(idx).match(/^<\s*([A-Za-z][\w:-]*)/);
    if (!match) return null;
    const name = match[1].toLowerCase();
    if (!FORM_CONTROL_TAGS.has(name)) return null;
    const end = findTagEnd(text, idx);
    if (end === null) return null;
    return { name, start: idx, end, text: text.slice(idx, end + 1) };
  };

  for (let i = Math.min(offset, text.length - 1); i >= 0; i--) {
    if (text[i] !== "<") continue;
    const tag = matchTagAt(i);
    if (tag) return tag;
  }

  let next = text.indexOf("<", offset);
  while (next !== -1) {
    const tag = matchTagAt(next);
    if (tag) return tag;
    next = text.indexOf("<", next + 1);
  }
  return null;
}

function findEnclosingTag(text: string, offset: number): TagInfo | null {
  for (let i = Math.min(offset, text.length - 1); i >= 0; i--) {
    if (text[i] !== "<") continue;
    if (text.startsWith("</", i) || text.startsWith("<!--", i)) continue;
    const match = text.slice(i).match(/^<\s*([A-Za-z][\w:-]*)/);
    if (!match) continue;
    const end = findTagEnd(text, i);
    if (end === null || end < offset) continue;
    return {
      name: match[1].toLowerCase(),
      rawName: match[1],
      start: i,
      end,
      text: text.slice(i, end + 1),
    };
  }
  return null;
}

function findOpeningTag(
  text: string,
  offset: number,
  preferredName?: string
): TagInfo | null {
  const enclosing = findEnclosingTag(text, offset);
  if (
    enclosing &&
    (!preferredName ||
      enclosing.name === preferredName.toLowerCase() ||
      (preferredName.toLowerCase() === "a" &&
        enclosing.rawName !== enclosing.rawName?.toLowerCase()))
  ) {
    return enclosing;
  }

  const escapedName = preferredName
    ? preferredName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : "[A-Za-z][\\w:-]*";
  const pattern = new RegExp(`<\\s*(${escapedName})\\b`, "gi");
  pattern.lastIndex = Math.max(0, offset);
  let match = pattern.exec(text);
  if (!match && preferredName) {
    pattern.lastIndex = 0;
    match = pattern.exec(text);
  }
  if (!match) return null;
  const end = findTagEnd(text, match.index);
  if (end === null) return null;
  return {
    name: match[1].toLowerCase(),
    rawName: match[1],
    start: match.index,
    end,
    text: text.slice(match.index, end + 1),
  };
}

function tagNameFromDiagnostic(message: string): string | undefined {
  return /<([A-Za-z][\w:-]*)\b/.exec(message)?.[1];
}

function findTagWithAttribute(
  text: string,
  offset: number,
  attributeName: string
): TagInfo | null {
  const enclosing = findEnclosingTag(text, offset);
  if (
    enclosing &&
    parseTagAttributes(enclosing.text).some(
      (attr) => attr.name.toLowerCase() === attributeName.toLowerCase()
    )
  ) {
    return enclosing;
  }
  const attribute = new RegExp(`\\b${attributeName}\\s*=`, "ig");
  attribute.lastIndex = Math.max(0, offset);
  let match = attribute.exec(text);
  if (!match) {
    attribute.lastIndex = 0;
    match = attribute.exec(text);
  }
  return match ? findEnclosingTag(text, match.index) : null;
}

function parseTagAttributes(tagText: string): ParsedAttr[] {
  const tagMatch = tagText.match(/^<\s*([A-Za-z][\w:-]*)\b/);
  if (!tagMatch) return [];
  const attrOffset = tagMatch[0].length;
  let attrPart = tagText.slice(attrOffset, Math.max(attrOffset, tagText.length - 1));
  attrPart = attrPart.replace(/\/\s*$/, "");
  const attrs: ParsedAttr[] = [];
  const attrRegex =
    /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(\"[^\"]*\"|'[^']*'|\{[^}]*\}|[^\s>]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrPart))) {
    const name = match[1];
    const rawValue = match[2];
    const attrStart = attrOffset + match.index;
    const nameStart = attrStart;
    const nameEnd = attrStart + name.length;
    if (rawValue === undefined) {
      attrs.push({
        name,
        value: "",
        dynamic: false,
        nameStart,
        nameEnd,
        valueStart: null,
        valueEnd: null,
      });
      continue;
    }
    if (rawValue.startsWith("{")) {
      attrs.push({
        name,
        value: null,
        dynamic: true,
        nameStart,
        nameEnd,
        valueStart: null,
        valueEnd: null,
      });
      continue;
    }
    let value = rawValue;
    let valueStart = attrStart + match[0].indexOf(rawValue);
    let valueEnd = valueStart + rawValue.length;
    if (
      (rawValue.startsWith("\"") && rawValue.endsWith("\"")) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      value = rawValue.slice(1, -1);
      valueStart += 1;
      valueEnd = valueStart + value.length;
    }
    attrs.push({
      name,
      value,
      dynamic: false,
      nameStart,
      nameEnd,
      valueStart,
      valueEnd,
    });
  }
  return attrs;
}

function findAttribute(
  attrs: ParsedAttr[],
  names: string[],
  caseInsensitive: boolean
): ParsedAttr | null {
  for (const attr of attrs) {
    for (const name of names) {
      if (
        caseInsensitive
          ? attr.name.toLowerCase() === name.toLowerCase()
          : attr.name === name
      ) {
        return attr;
      }
    }
  }
  return null;
}

function getTagInsertOffset(text: string, tag: TagInfo): number {
  return text[tag.end - 1] === "/" ? tag.end - 1 : tag.end;
}

function setAttributeValue(
  document: vscode.TextDocument,
  docText: string,
  edit: vscode.WorkspaceEdit,
  tag: TagInfo,
  attrs: ParsedAttr[],
  attrName: string,
  value: string,
  caseInsensitive: boolean,
  allowReplaceNonMatching: boolean
): boolean {
  const attr = findAttribute(attrs, [attrName], caseInsensitive);
  if (attr) {
    if (attr.dynamic) return false;
    const current = (attr.value ?? "").trim();
    if (current.length > 0 && current !== value && !allowReplaceNonMatching) {
      return false;
    }
    if (attr.valueStart !== null && attr.valueEnd !== null) {
      if (current === value) return false;
      const start = getPositionAt(document, tag.start + attr.valueStart, docText);
      const end = getPositionAt(document, tag.start + attr.valueEnd, docText);
      edit.replace(document.uri, new vscode.Range(start, end), value);
      return true;
    }
    const nameEnd = getPositionAt(document, tag.start + attr.nameEnd, docText);
    edit.insert(document.uri, nameEnd, `="${value}"`);
    return true;
  }
  const insertOffset = getTagInsertOffset(docText, tag);
  const insertPos = getPositionAt(document, insertOffset, docText);
  edit.insert(document.uri, insertPos, ` ${attrName}="${value}"`);
  return true;
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function findNearbyLabelTag(
  text: string,
  controlStart: number,
  controlLine: number,
  lineStarts: number[]
): TagInfo | null {
  const lines = text.split(/\r?\n/);
  const maxLinesBack = 3;
  for (let line = controlLine; line >= Math.max(0, controlLine - maxLinesBack); line--) {
    const lineText = lines[line] ?? "";
    const searchEnd =
      line === controlLine ? Math.max(0, controlStart - lineStarts[line]) : lineText.length;
    const slice = lineText.slice(0, searchEnd).toLowerCase();
    const idx = slice.lastIndexOf("<label");
    if (idx === -1) continue;
    const absStart = lineStarts[line] + idx;
    const end = findTagEnd(text, absStart);
    if (end === null) return null;
    return { name: "label", start: absStart, end, text: text.slice(absStart, end + 1) };
  }
  return null;
}

type TagRange = { start: number; end: number };

function readListItemTag(text: string, index: number): { end: number; closing: boolean; selfClosing: boolean } | null {
  if (text[index] !== "<") return null;
  const slice = text.slice(index, index + 5);
  const isClosing = slice.toLowerCase().startsWith("</li");
  const isOpening = slice.toLowerCase().startsWith("<li");
  if (!isClosing && !isOpening) return null;
  const nextChar = text[index + (isClosing ? 4 : 3)];
  if (nextChar && !/[\s/>]/.test(nextChar)) return null;
  const end = findTagEnd(text, index);
  if (end === null) return null;
  if (isClosing) {
    return { end: end + 1, closing: true, selfClosing: false };
  }
  const tagText = text.slice(index, end + 1);
  const selfClosing = /\/\s*>$/.test(tagText);
  return { end: end + 1, closing: false, selfClosing };
}

function findListItemRange(text: string, offset: number): TagRange | null {
  let idx = Math.min(offset, text.length - 1);
  while (idx >= 0) {
    const openIndex = text.lastIndexOf("<", idx);
    if (openIndex === -1) break;
    const tag = readListItemTag(text, openIndex);
    if (tag && !tag.closing) {
      if (tag.selfClosing) {
        return { start: openIndex, end: tag.end };
      }
      let depth = 1;
      let scan = tag.end;
      while (scan < text.length) {
        const next = text.indexOf("<", scan);
        if (next === -1) break;
        const nextTag = readListItemTag(text, next);
        if (!nextTag) {
          scan = next + 1;
          continue;
        }
        if (nextTag.closing) {
          depth -= 1;
          if (depth === 0) {
            return { start: openIndex, end: nextTag.end };
          }
        } else if (!nextTag.selfClosing) {
          depth += 1;
        }
        scan = nextTag.end;
      }
      return null;
    }
    idx = openIndex - 1;
  }
  return null;
}

function findFirstChildElementTag(
  text: string,
  start: number,
  end: number
): TagInfo | null {
  let idx = text.indexOf("<", start);
  while (idx !== -1 && idx < end) {
    if (text.startsWith("<!--", idx)) {
      const close = text.indexOf("-->", idx + 4);
      if (close === -1) return null;
      idx = text.indexOf("<", close + 3);
      continue;
    }
    if (text.startsWith("</", idx)) {
      idx = text.indexOf("<", idx + 2);
      continue;
    }
    const match = text.slice(idx).match(/^<\s*([A-Za-z][\w:-]*)/);
    if (!match) {
      idx = text.indexOf("<", idx + 1);
      continue;
    }
    const tagEnd = findTagEnd(text, idx);
    if (tagEnd === null || tagEnd > end) return null;
    return {
      name: match[1].toLowerCase(),
      rawName: match[1],
      start: idx,
      end: tagEnd,
      text: text.slice(idx, tagEnd + 1),
    };
  }
  return null;
}

function suggestLabelText(attrs: ParsedAttr[]): string {
  const placeholder = findAttribute(attrs, ["placeholder"], true);
  if (placeholder && !placeholder.dynamic && placeholder.value && placeholder.value.trim()) {
    return placeholder.value.trim();
  }
  const name = findAttribute(attrs, ["name"], true);
  if (name && !name.dynamic && name.value && name.value.trim()) {
    return name.value.trim();
  }
  return QUICK_FIX_PLACEHOLDER;
}

function addFormControlQuickFixes(
  document: vscode.TextDocument,
  diag: vscode.Diagnostic,
  actions: vscode.CodeAction[]
) {
  if (!diag.message.includes("Form control")) return;

  const docText = document.getText();
  const startOffset = getOffsetAt(document, diag.range.start, docText);
  const controlTag = findFormControlTag(docText, startOffset);
  if (!controlTag) {
    return;
  }

  const ext = path.extname(document.uri.fsPath).toLowerCase();
  const isJsx = ext === ".jsx" || ext === ".tsx";
  const labelAttrName = isJsx ? "htmlFor" : "for";
  const caseInsensitive = !isJsx;

  const controlAttrs = parseTagAttributes(controlTag.text);
  const idAttr = findAttribute(controlAttrs, ["id"], true);
  const idValue =
    idAttr && !idAttr.dynamic && idAttr.value && idAttr.value.trim()
      ? idAttr.value.trim()
      : null;
  const hasIdValue = !!idValue;
  const idAttrDynamic = !!(idAttr && idAttr.dynamic);

  const lineStarts = buildLineStarts(docText);
  const controlPos = getPositionAt(document, controlTag.start, docText);
  const labelTag = findNearbyLabelTag(
    docText,
    controlTag.start,
    controlPos.line,
    lineStarts
  );

  const labelAttrs = labelTag ? parseTagAttributes(labelTag.text) : [];
  const labelAttr = labelTag
    ? findAttribute(labelAttrs, [labelAttrName, "for", "htmlFor"], caseInsensitive)
    : null;
  const labelAttrValue =
    labelAttr && !labelAttr.dynamic && labelAttr.value && labelAttr.value.trim()
      ? labelAttr.value.trim()
      : null;
  const labelAttrEmpty =
    labelAttr && !labelAttr.dynamic && (labelAttr.value ?? "").trim().length === 0;
  const labelAttrDynamic = !!(labelAttr && labelAttr.dynamic);

  const placeholderId = QUICK_FIX_PLACEHOLDER;
  const labelText = suggestLabelText(controlAttrs);

  const insertLabelBeforeControl = (id: string) => {
    const edit = new vscode.WorkspaceEdit();
    const baseIndent =
      document.lineAt(controlPos.line).text.match(/^\s*/)?.[0] ?? "";
    const labelSnippet = `${baseIndent}<label ${labelAttrName}="${id}">${labelText}</label>\n`;
    edit.insert(
      document.uri,
      getPositionAt(document, controlTag.start, docText),
      labelSnippet
    );
    const action = new vscode.CodeAction(
      "Insert <label> before control",
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diag];
    action.edit = edit;
    actions.push(action);
  };

  const addAriaLabel = () => {
    const edit = new vscode.WorkspaceEdit();
    const didSet = setAttributeValue(
      document,
      docText,
      edit,
      controlTag,
      controlAttrs,
      "aria-label",
      QUICK_FIX_PLACEHOLDER,
      caseInsensitive,
      true
    );
    if (!didSet) return;
    const action = new vscode.CodeAction(
      `Add aria-label="${QUICK_FIX_PLACEHOLDER}"`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diag];
    action.edit = edit;
    actions.push(action);
  };

  if (hasIdValue) {
    if (labelTag) {
      if (!labelAttr || labelAttrEmpty) {
        if (labelAttrDynamic) {
          addAriaLabel();
          return;
        }
        const edit = new vscode.WorkspaceEdit();
        const didSet = setAttributeValue(
          document,
          docText,
          edit,
          labelTag,
          labelAttrs,
          labelAttrName,
          idValue,
          caseInsensitive,
          false
        );
        if (!didSet) {
          addAriaLabel();
          return;
        }
        const action = new vscode.CodeAction(
          `Add ${labelAttrName} to <label>`,
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);
      } else if (labelAttrValue && labelAttrValue !== idValue) {
        addAriaLabel();
      }
    } else {
      insertLabelBeforeControl(idValue);
    }
    return;
  }

  if (labelTag) {
    if (idAttrDynamic || labelAttrDynamic) {
      addAriaLabel();
      return;
    }
    const idToUse = labelAttrValue ?? placeholderId;
    const edit = new vscode.WorkspaceEdit();
    const idSet = setAttributeValue(
      document,
      docText,
      edit,
      controlTag,
      controlAttrs,
      "id",
      idToUse,
      caseInsensitive,
      false
    );
    if (!idSet) return;
    if (!labelAttrValue || labelAttrEmpty) {
      setAttributeValue(
        document,
        docText,
        edit,
        labelTag,
        labelAttrs,
        labelAttrName,
        idToUse,
        caseInsensitive,
        false
      );
    }
    const action = new vscode.CodeAction(
      "Add id and link <label>",
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diag];
    action.edit = edit;
    actions.push(action);
    return;
  }

  addAriaLabel();

  if (!idAttrDynamic) {
    const edit = new vscode.WorkspaceEdit();
    const idSet = setAttributeValue(
      document,
      docText,
      edit,
      controlTag,
      controlAttrs,
      "id",
      placeholderId,
      caseInsensitive,
      false
    );
    if (!idSet) return;
    const baseIndent =
      document.lineAt(controlPos.line).text.match(/^\s*/)?.[0] ?? "";
    const labelSnippet = `${baseIndent}<label ${labelAttrName}="${placeholderId}">${labelText}</label>\n`;
    edit.insert(
      document.uri,
      getPositionAt(document, controlTag.start, docText),
      labelSnippet
    );
    const action = new vscode.CodeAction(
      "Add <label> and id",
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diag];
    action.edit = edit;
    actions.push(action);
  }
}

/** Quick fixes */
class ZemCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.ProviderResult<(vscode.CodeAction | vscode.Command)[]> {
    const actions: vscode.CodeAction[] = [];

    for (const diag of context.diagnostics) {
      if (isListNestingDiagnostic(diag)) {
        const docText = document.getText();
        const lines = docText.split(/\r?\n/);
        const lineAt = (idx: number) => lines[idx] ?? "";
        const ext = path.extname(document.uri.fsPath).toLowerCase();
        const isJsx = ext === ".jsx" || ext === ".tsx";

        let startLine = diag.range.start.line;
        let endLine = diag.range.start.line;
        const startOffset = getOffsetAt(document, diag.range.start, docText);
        let wrapsOnlyListMarkup = true;

        let jsBlockStart: number | null = null;
        for (let i = startLine; i >= 0; i--) {
          const trimmed = lineAt(i).trim();
          if (!trimmed) continue;
          if (trimmed.startsWith("<li") || trimmed.startsWith("</li")) {
            continue;
          }
          if (trimmed.startsWith("{") && !trimmed.includes("<")) {
            jsBlockStart = i;
            break;
          }
          if (trimmed.startsWith("<")) break;
          break;
        }

        if (jsBlockStart !== null) {
          startLine = jsBlockStart;
          for (let i = jsBlockStart + 1; i < lines.length; i++) {
            const trimmed = lineAt(i).trim();
            if (!trimmed) continue;
            if (trimmed.startsWith("}") && !trimmed.includes("<")) {
              endLine = i;
              break;
            }
          }
        } else {
          const liRange = findListItemRange(docText, startOffset);
          if (liRange) {
            const startPos = getPositionAt(document, liRange.start, docText);
            const endPos = getPositionAt(document, liRange.end, docText);
            startLine = startPos.line;
            endLine = endPos.line;
            if (isJsx) {
              const beforeListItem = lineAt(startLine).slice(0, startPos.character);
              const afterListItem = lineAt(endLine).slice(endPos.character);
              wrapsOnlyListMarkup =
                beforeListItem.trim().length === 0 &&
                afterListItem.trim().length === 0;
            }
          } else {
            for (let i = startLine - 1; i >= 0; i--) {
              const trimmed = lineAt(i).trim();
              if (!trimmed) break;
              if (trimmed.startsWith("<li") || trimmed.startsWith("</li")) {
                startLine = i;
                continue;
              }
              break;
            }

            for (let i = endLine + 1; i < lines.length; i++) {
              const trimmed = lineAt(i).trim();
              if (!trimmed) break;
              if (trimmed.startsWith("<li") || trimmed.startsWith("</li")) {
                endLine = i;
                continue;
              }
              break;
            }
          }
        }

        if (!wrapsOnlyListMarkup) continue;

        const baseIndent = lineAt(startLine).match(/^\s*/)?.[0] ?? "";
        const edit = new vscode.WorkspaceEdit();
        edit.insert(
          document.uri,
          new vscode.Position(startLine, 0),
          `${baseIndent}<ul>\n`
        );
        edit.insert(
          document.uri,
          new vscode.Position(endLine, lineAt(endLine).length),
          `\n${baseIndent}</ul>`
        );

        const action = new vscode.CodeAction(
          "Wrap with <ul>",
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);
      }

      if (isNavLinksDiagnostic(diag)) {
        const docText = document.getText();
        const startOffset = getOffsetAt(document, diag.range.start, docText);
        const tag = findOpeningTag(docText, startOffset, "nav");
        if (tag && docText[tag.end - 1] !== "/") {
          const tagLine = getPositionAt(document, tag.start, docText).line;
          const baseIndent = document.lineAt(tagLine).text.match(/^\s*/)?.[0] ?? "";
          const insertPos = getPositionAt(document, tag.end + 1, docText);
          const edit = new vscode.WorkspaceEdit();
          edit.insert(
            document.uri,
            insertPos,
            `\n${baseIndent}${getIndentUnit(document)}<a href=\"${QUICK_FIX_PLACEHOLDER}\">${QUICK_FIX_PLACEHOLDER}</a>`
          );
          const action = new vscode.CodeAction(
            `Add <a href="${QUICK_FIX_PLACEHOLDER}"> inside <nav>`,
            vscode.CodeActionKind.QuickFix
          );
          action.diagnostics = [diag];
          action.edit = edit;
          actions.push(action);
        }
      }

      if (isTabindexDiagnostic(diag)) {
        const docText = document.getText();
        const startOffset = getOffsetAt(document, diag.range.start, docText);
        const tag = findTagWithAttribute(docText, startOffset, "tabindex");
        const attr = tag
          ? findAttribute(parseTagAttributes(tag.text), ["tabindex"], true)
          : null;
        if (tag && attr && attr.valueStart !== null && attr.valueEnd !== null) {
          const valueRange = new vscode.Range(
            getPositionAt(document, tag.start + attr.valueStart, docText),
            getPositionAt(document, tag.start + attr.valueEnd, docText)
          );
          const editZero = new vscode.WorkspaceEdit();
          editZero.replace(document.uri, valueRange, "0");
          const actionZero = new vscode.CodeAction(
            'Set tabindex to "0"',
            vscode.CodeActionKind.QuickFix
          );
          actionZero.diagnostics = [diag];
          actionZero.edit = editZero;
          actions.push(actionZero);

          const editMinus = new vscode.WorkspaceEdit();
          editMinus.replace(document.uri, valueRange, "-1");
          const actionMinus = new vscode.CodeAction(
            'Set tabindex to "-1"',
            vscode.CodeActionKind.QuickFix
          );
          actionMinus.diagnostics = [diag];
          actionMinus.edit = editMinus;
          actions.push(actionMinus);
        }
      }

      if (isDocumentTitleDiagnostic(diag)) {
        const docText = document.getText();
        if (diag.message.includes("missing non-empty <title>")) {
          const headMatch = /<head\b[^>]*>/i.exec(docText);
          if (headMatch) {
            const headStart = headMatch.index;
            const headEnd = findTagEnd(docText, headStart);
            if (headEnd !== null && docText[headEnd - 1] !== "/") {
              const headLine = getPositionAt(document, headStart, docText).line;
              const baseIndent =
                document.lineAt(headLine).text.match(/^\s*/)?.[0] ?? "";
              const insertPos = getPositionAt(document, headEnd + 1, docText);
              const edit = new vscode.WorkspaceEdit();
              edit.insert(
                document.uri,
                insertPos,
                `\n${baseIndent}${getIndentUnit(document)}<title>${QUICK_FIX_PLACEHOLDER}</title>`
              );
              const action = new vscode.CodeAction(
                `Add <title>${QUICK_FIX_PLACEHOLDER}</title>`,
                vscode.CodeActionKind.QuickFix
              );
              action.diagnostics = [diag];
              action.edit = edit;
              actions.push(action);
            }
          } else {
            const htmlMatch = /<html\b[^>]*>/i.exec(docText);
            if (htmlMatch) {
              const htmlStart = htmlMatch.index;
              const htmlEnd = findTagEnd(docText, htmlStart);
              if (htmlEnd !== null && docText[htmlEnd - 1] !== "/") {
                const htmlLine = getPositionAt(document, htmlStart, docText).line;
                const baseIndent =
                  document.lineAt(htmlLine).text.match(/^\s*/)?.[0] ?? "";
                const indent = getIndentUnit(document);
                const insertPos = getPositionAt(document, htmlEnd + 1, docText);
                const edit = new vscode.WorkspaceEdit();
                edit.insert(
                  document.uri,
                  insertPos,
                  `\n${baseIndent}${indent}<head>\n${baseIndent}${indent}${indent}<title>${QUICK_FIX_PLACEHOLDER}</title>\n${baseIndent}${indent}</head>`
                );
                const action = new vscode.CodeAction(
                  `Add <head> and <title>${QUICK_FIX_PLACEHOLDER}</title>`,
                  vscode.CodeActionKind.QuickFix
                );
                action.diagnostics = [diag];
                action.edit = edit;
                actions.push(action);
              }
            }
          }
        }

        if (diag.message.includes("<title> element must not be empty")) {
          const startOffset = getOffsetAt(document, diag.range.start, docText);
          const openTag = findOpeningTag(docText, startOffset, "title");
          if (openTag) {
            const openEnd = openTag.end + 1;
            const closeStart = docText.indexOf("</title>", openEnd);
            if (closeStart !== -1) {
              const edit = new vscode.WorkspaceEdit();
              edit.replace(
                document.uri,
                new vscode.Range(
                  getPositionAt(document, openEnd, docText),
                  getPositionAt(document, closeStart, docText)
                ),
                QUICK_FIX_PLACEHOLDER
              );
              const action = new vscode.CodeAction(
                `Fill <title> with "${QUICK_FIX_PLACEHOLDER}"`,
                vscode.CodeActionKind.QuickFix
              );
              action.diagnostics = [diag];
              action.edit = edit;
              actions.push(action);
            }
          }
        }
      }

      if (isSingleMainDiagnostic(diag)) {
        const docText = document.getText();

        if (diag.message.includes("Document missing <main> landmark")) {
          const bodyMatch = /<body\b[^>]*>/i.exec(docText);
          if (bodyMatch) {
            const bodyStart = bodyMatch.index;
            const bodyEnd = findTagEnd(docText, bodyStart);
            if (bodyEnd !== null && docText[bodyEnd - 1] !== "/") {
              const bodyLine = getPositionAt(document, bodyStart, docText).line;
              const baseIndent =
                document.lineAt(bodyLine).text.match(/^\s*/)?.[0] ?? "";
              const insertPos = getPositionAt(document, bodyEnd + 1, docText);
              const edit = new vscode.WorkspaceEdit();
              edit.insert(
                document.uri,
                insertPos,
                `\n${baseIndent}${getIndentUnit(document)}<main>${QUICK_FIX_PLACEHOLDER}</main>`
              );
              const action = new vscode.CodeAction(
                `Add <main>${QUICK_FIX_PLACEHOLDER}</main>`,
                vscode.CodeActionKind.QuickFix
              );
              action.diagnostics = [diag];
              action.edit = edit;
              actions.push(action);
            }
          }
        }

        if (diag.message.includes("Only one <main>")) {
          const startOffset = getOffsetAt(document, diag.range.start, docText);
          const openTag = findOpeningTag(docText, startOffset, "main");
          if (openTag) {
            const openStart = openTag.start;
            const openNameStart = openStart + 1;
            const openNameEnd = openNameStart + 4;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              document.uri,
              new vscode.Range(
                getPositionAt(document, openNameStart, docText),
                getPositionAt(document, openNameEnd, docText)
              ),
              "section"
            );

            const closeRegex = /<\/main\s*>/gi;
            closeRegex.lastIndex = openTag.end + 1;
            const closeMatch = closeRegex.exec(docText);
            if (closeMatch) {
              const closeStart = closeMatch.index;
              const closeNameStart = closeStart + 2;
              const closeNameEnd = closeNameStart + 4;
              edit.replace(
                document.uri,
                new vscode.Range(
                  getPositionAt(document, closeNameStart, docText),
                  getPositionAt(document, closeNameEnd, docText)
                ),
                "section"
              );
            }

            const action = new vscode.CodeAction(
              "Change duplicate <main> to <section>",
              vscode.CodeActionKind.QuickFix
            );
            action.diagnostics = [diag];
            action.edit = edit;
            actions.push(action);
          }
        }
      }

      if (isAriaValidAttrValueDiagnostic(diag)) {
        const parsed = parseInvalidAriaValueMessage(diag.message);
        if (parsed) {
          const docText = document.getText();
          const startOffset = getOffsetAt(document, diag.range.start, docText);
          const tag = findEnclosingTag(docText, startOffset);
          if (tag) {
            const ext = path.extname(document.uri.fsPath).toLowerCase();
            const isJsx = ext === ".jsx" || ext === ".tsx";
            const attrs = parseTagAttributes(tag.text);
            const replacement = getAriaQuickFixValue(parsed.attr);
            const edit = new vscode.WorkspaceEdit();
            const didSet = setAttributeValue(
              document,
              docText,
              edit,
              tag,
              attrs,
              parsed.attr,
              replacement,
              !isJsx,
              true
            );
            if (didSet) {
              const action = new vscode.CodeAction(
                `Set ${parsed.attr}="${replacement}"`,
                vscode.CodeActionKind.QuickFix
              );
              action.diagnostics = [diag];
              action.edit = edit;
              actions.push(action);
            }
          }
        }
      }

      if (isSingleH1Diagnostic(diag)) {
        const docText = document.getText();
        const startOffset = getOffsetAt(document, diag.range.start, docText);
        const openTag = findOpeningTag(docText, startOffset, "h1");
        if (openTag) {
          const openStart = openTag.start;
          const openNameStart = openStart + 1;
          const openNameEnd = openNameStart + 2;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            document.uri,
            new vscode.Range(
              getPositionAt(document, openNameStart, docText),
              getPositionAt(document, openNameEnd, docText)
            ),
            "h2"
          );

          const closeRegex = /<\/h1\s*>/gi;
          closeRegex.lastIndex = openTag.end + 1;
          const closeMatch = closeRegex.exec(docText);
          if (closeMatch) {
            const closeStart = closeMatch.index;
            const closeNameStart = closeStart + 2;
            const closeNameEnd = closeNameStart + 2;
            edit.replace(
              document.uri,
              new vscode.Range(
                getPositionAt(document, closeNameStart, docText),
                getPositionAt(document, closeNameEnd, docText)
              ),
              "h2"
            );
          }

          const action = new vscode.CodeAction(
            "Change to <h2>",
            vscode.CodeActionKind.QuickFix
          );
          action.diagnostics = [diag];
          action.edit = edit;
          actions.push(action);
        }
      }

      if (isHeadingOrderDiagnostic(diag)) {
        const parsed = parseHeadingOrderMessage(diag.message);
        if (parsed) {
          const desired = computeHeadingOrderFixLevel(
            parsed.current,
            parsed.last
          );
          if (desired && desired !== parsed.current) {
            const docText = document.getText();
            const startOffset = getOffsetAt(
              document,
              diag.range.start,
              docText
            );
            const openTag = findOpeningTag(
              docText,
              startOffset,
              `h${parsed.current}`
            );
            if (openTag) {
              const openStart = openTag.start;
              const openNameStart = openStart + 1;
              const openNameEnd = openNameStart + 2;
              const edit = new vscode.WorkspaceEdit();
              edit.replace(
                document.uri,
                new vscode.Range(
                  getPositionAt(document, openNameStart, docText),
                  getPositionAt(document, openNameEnd, docText)
                ),
                `h${desired}`
              );

              const closeRegex = new RegExp(`</h${parsed.current}\\s*>`, "ig");
              closeRegex.lastIndex = openTag.end + 1;
              const closeMatch = closeRegex.exec(docText);
              if (closeMatch) {
                const closeStart = closeMatch.index;
                const closeNameStart = closeStart + 2;
                const closeNameEnd = closeNameStart + 2;
                edit.replace(
                  document.uri,
                  new vscode.Range(
                    getPositionAt(document, closeNameStart, docText),
                    getPositionAt(document, closeNameEnd, docText)
                  ),
                  `h${desired}`
                );
              }

              const action = new vscode.CodeAction(
                `Change to <h${desired}>`,
                vscode.CodeActionKind.QuickFix
              );
              action.diagnostics = [diag];
              action.edit = edit;
              actions.push(action);
            }
          }
        }
      }

      if (isSectionHeadingDiagnostic(diag)) {
        const docText = document.getText();
        const sectionStart = getOffsetAt(
          document,
          diag.range.start,
          docText
        );
        const tagEnd = findTagEnd(docText, sectionStart);
        if (tagEnd !== null && docText[tagEnd - 1] !== "/") {
          const ext = path.extname(document.uri.fsPath).toLowerCase();
          const isJsx = ext === ".jsx" || ext === ".tsx";
          const caseInsensitive = !isJsx;
          const sectionTag: TagInfo = {
            name: "section",
            start: sectionStart,
            end: tagEnd,
            text: docText.slice(sectionStart, tagEnd + 1),
          };
          const sectionAttrs = parseTagAttributes(sectionTag.text);
          const sectionClose = docText.indexOf("</section", tagEnd);
          const rawChildTag =
            sectionClose === -1
              ? null
              : findFirstChildElementTag(docText, tagEnd + 1, sectionClose);
          const childTag =
            rawChildTag && rawChildTag.rawName && /^[A-Z]/.test(rawChildTag.rawName)
              ? null
              : rawChildTag;
          const edit = new vscode.WorkspaceEdit();

          if (childTag) {
            const childAttrs = parseTagAttributes(childTag.text);
            const idAttr = findAttribute(childAttrs, ["id"], true);
            const childId =
              idAttr && !idAttr.dynamic && idAttr.value && idAttr.value.trim()
                ? idAttr.value.trim()
                : null;
            const labelId = childId ?? QUICK_FIX_PLACEHOLDER;
            const didSetSection = setAttributeValue(
              document,
              docText,
              edit,
              sectionTag,
              sectionAttrs,
              "aria-labelledby",
              labelId,
              caseInsensitive,
              false
            );
            if (!didSetSection) continue;
            if (!childId) {
              const didSetChild = setAttributeValue(
                document,
                docText,
                edit,
                childTag,
                childAttrs,
                "id",
                labelId,
                caseInsensitive,
                false
              );
              if (!didSetChild) continue;
            }
            const action = new vscode.CodeAction(
              `Add aria-labelledby="${labelId}"`,
              vscode.CodeActionKind.QuickFix
            );
            action.diagnostics = [diag];
            action.edit = edit;
            actions.push(action);
          } else {
            const didSet = setAttributeValue(
              document,
              docText,
              edit,
              sectionTag,
              sectionAttrs,
              "aria-label",
              QUICK_FIX_PLACEHOLDER,
              caseInsensitive,
              false
            );
            if (!didSet) continue;
            const action = new vscode.CodeAction(
              `Add aria-label="${QUICK_FIX_PLACEHOLDER}"`,
              vscode.CodeActionKind.QuickFix
            );
            action.diagnostics = [diag];
            action.edit = edit;
            actions.push(action);
          }
        }
      }

      addFormControlQuickFixes(document, diag, actions);

      const docText = document.getText();
      const startOffset = getOffsetAt(document, diag.range.start, docText);
      const tag = findOpeningTag(
        docText,
        startOffset,
        tagNameFromDiagnostic(diag.message)
      );
      if (!tag) continue;

      const tagName = tag.rawName ?? tag.name;
      const linkTextDiag = isLinkTextDiagnostic(diag);
      const ext = path.extname(document.uri.fsPath).toLowerCase();
      const isJsx = ext === ".jsx" || ext === ".tsx";
      const tagAttrs = parseTagAttributes(tag.text);

      const addAttr = (
        title: string,
        attrName: string,
        value: string,
        match: (m: string) => boolean
      ) => {
        if (!match(diag.message)) return;
        const edit = new vscode.WorkspaceEdit();
        const didSet = setAttributeValue(
          document,
          docText,
          edit,
          tag,
          tagAttrs,
          attrName,
          value,
          !isJsx,
          false
        );
        if (!didSet) return;
        const action = new vscode.CodeAction(
          title,
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);
      };

      addAttr(
        `Add alt="${QUICK_FIX_PLACEHOLDER}"`,
        "alt",
        QUICK_FIX_PLACEHOLDER,
        (m) => m.includes("img") && m.includes("alt")
      );
      if (diag.message.includes("href attribute")) {
        const edit = new vscode.WorkspaceEdit();
        const didSetHref = setAttributeValue(
          document,
          docText,
          edit,
          tag,
          tagAttrs,
          "href",
          QUICK_FIX_PLACEHOLDER,
          !isJsx,
          false
        );
        if (didSetHref) {
          const action = new vscode.CodeAction(
            `Add href="${QUICK_FIX_PLACEHOLDER}"`,
            vscode.CodeActionKind.QuickFix
          );
          action.diagnostics = [diag];
          action.edit = edit;
          actions.push(action);
        }

        if (tagName && tagName.toLowerCase() !== "a") {
          const toEdit = new vscode.WorkspaceEdit();
          const didSetTo = setAttributeValue(
            document,
            docText,
            toEdit,
            tag,
            tagAttrs,
            "to",
            QUICK_FIX_PLACEHOLDER,
            !isJsx,
            false
          );
          if (didSetTo) {
            const toAction = new vscode.CodeAction(
              `Add to="${QUICK_FIX_PLACEHOLDER}"`,
              vscode.CodeActionKind.QuickFix
            );
            toAction.diagnostics = [diag];
            toAction.edit = toEdit;
            actions.push(toAction);
          }
        }
      }
      if (diag.message.includes("missing <caption>")) {
        const tagLine = getPositionAt(document, tag.start, docText).line;
        const baseIndent = document.lineAt(tagLine).text.match(/^\s*/)?.[0] ?? "";
        const capPos = getPositionAt(document, tag.end + 1, docText);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(
          document.uri,
          capPos,
          `${docText.includes("\r\n") ? "\r\n" : "\n"}${baseIndent}${getIndentUnit(document)}<caption>${QUICK_FIX_PLACEHOLDER}</caption>`
        );
        const action = new vscode.CodeAction(
          `Add <caption>${QUICK_FIX_PLACEHOLDER}</caption>`,
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);
      }
      addAttr(
        `Add title="${QUICK_FIX_PLACEHOLDER}"`,
        "title",
        QUICK_FIX_PLACEHOLDER,
        (m) =>
          m.includes("missing title attribute") ||
          m.includes("title attribute is empty")
      );
      addAttr(
        `Add lang="${QUICK_FIX_PLACEHOLDER}"`,
        "lang",
        QUICK_FIX_PLACEHOLDER,
        (m) =>
          m.includes("missing lang attribute") ||
          m.includes("lang attribute is empty")
      );
      addAttr(
        `Add aria-label="${QUICK_FIX_PLACEHOLDER}"`,
        "aria-label",
        QUICK_FIX_PLACEHOLDER,
        (m) =>
          linkTextDiag ||
          m.includes("accessible text") ||
          m.includes("accessible name") ||
          m.includes("aria-label attribute is empty")
      );
      addAttr(
        `Add alt="${QUICK_FIX_PLACEHOLDER}"`,
        "alt",
        QUICK_FIX_PLACEHOLDER,
        (m) => m.includes('input type="image"') && m.includes("alt attribute")
      );
    }

    return actions;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection("zemdomu");
  const log = vscode.window.createOutputChannel("ZemDomu");
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  const issueTracker = new IssueTracker(statusBarItem);
  const workspaceProgressListeners = new Set<
    (update: WorkspaceScanProgress) => void
  >();
  let activeWorkspaceCommand: Promise<string> | null = null;
  const cfg = (resource?: vscode.Uri) =>
    vscode.workspace.getConfiguration("zemdomu", resource);

  const devMode = cfg().get("devMode", false) as boolean;
  let verboseLogging = cfg().get("enableVerboseLogging", false) as boolean;

  function verboseEvent(event: Record<string, unknown>) {
    if (!verboseLogging) return;
    try {
      const payload = { ts: new Date().toISOString(), ...event };
      log.appendLine(`[verbose] ${JSON.stringify(payload)}`);
    } catch (err) {
      log.appendLine(
        `[verbose] Failed to serialize log event: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  const perfDiagnostics = new PerformanceDiagnostics(devMode);
  perfDiagnostics.reportBundleSize(context.extensionPath);

  function workspaceFolderForUri(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    const getWorkspaceFolder = vscode.workspace.getWorkspaceFolder;
    if (typeof getWorkspaceFolder === "function") {
      const folder = getWorkspaceFolder(uri);
      if (folder) return folder;
    }
    const target = path.resolve(uri.fsPath).toLowerCase();
    return [...(vscode.workspace.workspaceFolders ?? [])]
      .filter((folder) => {
        const root = path.resolve(folder.uri.fsPath).toLowerCase();
        return target === root || target.startsWith(`${root}${path.sep}`);
      })
      .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
  }

  function analysisRoot(resource?: vscode.Uri): string {
    if (!resource) return process.cwd();
    return workspaceFolderForUri(resource)?.uri.fsPath ?? path.dirname(resource.fsPath);
  }

  function buildOptions(
    resource?: vscode.Uri,
    rootDir = analysisRoot(resource)
  ): ProjectLinterOptions {
    const c = cfg(resource);

    const rules: Record<string, "off" | "warning" | "error"> = {};
    for (const name of RULE_NAMES) {
      const enabled = c.get(`rules.${name}`, true) as boolean;
      if (!enabled) {
        rules[name] = "off";
      } else {
        const sev = c.get(`severity.${name}`, "warning") as "warning" | "error";
        rules[name] = sev;
      }
    }

    const requestedCrossComponentAnalysis = c.get(
      "crossComponentAnalysis",
      true
    ) as boolean;
    const crossComponentAnalysis = resource && !workspaceFolderForUri(resource)
      ? false
      : requestedCrossComponentAnalysis;
    const crossComponentDepth = c.get("crossComponentDepth", 50) as number;
    const opts: ProjectLinterOptions = {
      rules,
      crossComponentAnalysis,
      crossComponentDepth,
      rootDir,
      perf: perfDiagnostics,
    };

    log.appendLine(
      `Options: cross=${crossComponentAnalysis} depth=${crossComponentDepth} rootDir=${rootDir}`
    );
    return opts;
  }

  function ruleSeverity(
    rule: string,
    resource?: vscode.Uri
  ): vscode.DiagnosticSeverity {
    const sev = cfg(resource).get(`severity.${rule}`, "warning") as
      | "warning"
      | "error";
    return sev === "error"
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning;
  }

  function rebuildCore() {
    try {
      // helpful when debugging packaging issues
      // @ts-ignore
      log.appendLine(`zemdomu resolved at: ${require.resolve("zemdomu")}`);
    } catch {}
  }
  rebuildCore();

  function toDiagnostics(
    results: LintResult[],
    ruleSeverity: (r: string) => vscode.DiagnosticSeverity
  ): vscode.Diagnostic[] {
    return results.map((r) => {
      const rWithCode = r as LintResultWithCode;
      const line = Number.isFinite(r.line) ? r.line : 0;
      const col = Number.isFinite(r.column) ? r.column : 0;
      const start = new vscode.Position(line, col);
      const end = new vscode.Position(line, Math.max(col + 1, col));
      const d = new vscode.Diagnostic(
        new vscode.Range(start, end),
        r.message,
        ruleSeverity(r.rule)
      );
      d.source = "ZemDomu";
      const codeValue = rWithCode.code ?? r.rule;
      const docsUri = docsUriForRule(r.rule);
      d.code = docsUri ? { value: codeValue, target: docsUri } : codeValue;
      if (r.related && r.related.length) {
        d.relatedInformation = r.related.map((rel) => {
          const relLine = Number.isFinite(rel.line) ? rel.line : 0;
          const relCol = Number.isFinite(rel.column) ? rel.column : 0;
          const relRange = new vscode.Range(
            new vscode.Position(relLine, relCol),
            new vscode.Position(relLine, Math.max(relCol + 1, relCol))
          );
          return new vscode.DiagnosticRelatedInformation(
            new vscode.Location(vscode.Uri.file(rel.filePath), relRange),
            rel.message ?? "Related location"
          );
        });
      }
      return d;
    });
  }

  function applyDiagnosticsCached(
    uri: vscode.Uri,
    diags: vscode.Diagnostic[],
    etag: string | null
  ) {
    const fp = uri.fsPath;
    const prev = diagCache.get(fp);
    if (prev && equalDiagnostics(prev.diags, diags)) {
      // No visual churn, keep cache fresh if etag changed
      diagCache.set(fp, { etag, diags: prev.diags });
      return false; // not updated
    }
    diagnostics.set(uri, diags);
    diagCache.set(fp, { etag, diags });
    issueTracker.updateFile(uri, diags);
    return true; // updated
  }

  function publishDiagnostics(
    runId: number,
    uri: vscode.Uri,
    results: LintResult[],
    diags: vscode.Diagnostic[],
    etag: string | null
  ) {
    const updated = applyDiagnosticsCached(uri, diags, etag);
    if (verboseLogging) {
      const keys = results.map((r) => keyLint(r));
      verboseEvent({
        event: "diagnosticsPublished",
        runId,
        filePath: uri.fsPath,
        uri: uri.toString(),
        etag,
        count: diags.length,
        updated,
        keysPreview: previewKeys(keys),
      });
    }
    return updated;
  }

  function buildRemappedResults(map: Map<string, LintResult[]>) {
    const files = Array.from(map.keys());

    // Build index of component base names for singleH1 remapping
    const nameIndex = new Map<string, string[]>();
    for (const fp of files) {
      const base = path.basename(fp, path.extname(fp));
      if (!nameIndex.has(base)) nameIndex.set(base, []);
      nameIndex.get(base)!.push(fp);
    }

    // Remap cross-component results deterministically
    const remapped = new Map<string, LintResult[]>();
    for (const fp of files) remapped.set(fp, []);
    for (const [fp, results] of map.entries()) {
      for (const r of results) {
        let target = r.filePath ?? fp;
        let adjusted: LintResult = r.filePath ? r : { ...r, filePath: target };

        if (r.rule === "singleH1" && (!r.filePath || r.filePath === fp)) {
          const m = r.message.match(/component '([^']+)'/);
          if (m) {
            const name = m[1];
            const candidates = nameIndex.get(name);
            if (candidates && candidates.length === 1) {
              target = candidates[0];
              adjusted = { ...r, line: 0, column: 0, filePath: target };
            }
          }
        }

        if (!remapped.has(target)) remapped.set(target, []);
        remapped.get(target)!.push(adjusted);
      }
    }

    // Preserve every Core finding. Repeated violations can legitimately share a
    // rule, message, and source line, especially in compact HTML.
    const out = new Map<string, LintResult[]>();
    for (const [fp, results] of remapped.entries()) {
      out.set(fp, stableSort(results));
    }

    return out;
  }

  async function sourceForFile(
    filePath: string,
    contentOverrides?: Map<string, string>
  ): Promise<string | null> {
    const override = contentOverrides?.get(path.resolve(filePath).toLowerCase());
    if (override !== undefined) return override;
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }

  async function applyInlineControls(
    map: Map<string, LintResult[]>,
    contentOverrides?: Map<string, string>
  ): Promise<Map<string, LintResult[]>> {
    const filtered = new Map<string, LintResult[]>();
    await Promise.all(
      Array.from(map.entries()).map(async ([filePath, results]) => {
        const source = await sourceForFile(filePath, contentOverrides);
        if (source === null) {
          filtered.set(filePath, results);
          return;
        }

        let kept = applyInlineDisableDirectives(source, results);
        if (path.extname(filePath).toLowerCase() === ".vue") {
          const template = getVueTemplateRange(source);
          const legacyTemplateResults = results.filter(
            (result) => !Number.isFinite((result as LintResultWithCode).offset)
          );
          if (template && legacyTemplateResults.length > 0) {
            const templateKept = new Set(
              applyInlineDisableDirectives(
                source.slice(template.start, template.end),
                legacyTemplateResults
              )
            );
            kept = kept.filter(
              (result) =>
                Number.isFinite((result as LintResultWithCode).offset) ||
                templateKept.has(result)
            );
          }
        }
        filtered.set(filePath, kept);
      })
    );
    return filtered;
  }

  type LintGroup = {
    resource: vscode.Uri;
    rootDir: string;
    entries: vscode.Uri[];
  };

  function groupLintEntries(entryUris: vscode.Uri[]): LintGroup[] {
    const groups = new Map<string, LintGroup>();
    for (const uri of entryUris) {
      const folder = workspaceFolderForUri(uri);
      const rootDir = analysisRoot(uri);
      const key = `${folder?.uri.fsPath ?? uri.fsPath}\0${rootDir}`.toLowerCase();
      const existing = groups.get(key);
      if (existing) existing.entries.push(uri);
      else groups.set(key, { resource: uri, rootDir, entries: [uri] });
    }
    return Array.from(groups.values()).sort((a, b) =>
      a.rootDir.localeCompare(b.rootDir)
    );
  }

  async function lintProjectGroups(
    entryUris: vscode.Uri[],
    onProgress?: (progress: ProjectGroupProgress) => void
  ): Promise<Map<string, LintResult[]>> {
    const aggregated = new Map<string, LintResult[]>();
    const groups = groupLintEntries(entryUris);
    // Construct and consume each linter as one sequential unit. This keeps
    // shipped Core versions with process-wide resolver state isolated by root.
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      onProgress?.({
        completedGroups: index,
        totalGroups: groups.length,
        currentGroup: index + 1,
        currentGroupFiles: group.entries.length,
      });
      const groupCore = new ProjectLinter(
        buildOptions(group.resource, group.rootDir)
      );
      const groupMap = await groupCore.lintFiles(
        group.entries.map((entry) => entry.fsPath)
      );
      const remapped = buildRemappedResults(await applyInlineControls(groupMap));
      for (const [filePath, results] of remapped) {
        if (!aggregated.has(filePath)) aggregated.set(filePath, []);
        aggregated.get(filePath)!.push(...results);
      }
      onProgress?.({
        completedGroups: index + 1,
        totalGroups: groups.length,
        currentGroup: index + 1,
        currentGroupFiles: group.entries.length,
      });
    }
    return new Map(
      Array.from(aggregated, ([filePath, results]) => [
        filePath,
        stableSort(results),
      ])
    );
  }

  async function lintEntries(entryUris: vscode.Uri[]) {
    const eligibleUris = entryUris.filter(
      (uri) =>
        !/[\\/]node_modules[\\/]/.test(uri.fsPath) &&
        !/[\\/](dist|out)[\\/]/.test(uri.fsPath)
    );
    const entries = eligibleUris.map((uri) => uri.fsPath);

    if (entries.length === 0) return;

    const runId = ++globalRunId; // snapshot run id for this pass
    const t0 = Date.now();
    verboseEvent({
      event: "lintRunStart",
      scope: "entries",
      runId,
      entryCount: entries.length,
      startedAt: new Date(t0).toISOString(),
      uris: verboseLogging ? entryUris.map((u) => u.toString()) : undefined,
    });

    let map: Map<string, LintResult[]>;
    try {
      map = await lintProjectGroups(eligibleUris);
    } catch (error) {
      console.error("[ZemDomu] lintFiles error:", error);
      log.appendLine(
        `Document lint failed for ${entries.join(", ")}: ${
          error instanceof Error ? error.stack ?? error.message : String(error)
        }`
      );
      verboseEvent({
        event: "lintRunFailed",
        scope: "entries",
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Bail if a newer run started after this one
    if (runId !== globalRunId) {
      verboseEvent({
        event: "lintRunDiscarded",
        scope: "entries",
        runId,
        stage: "postCompute",
      });
      return;
    }

    const remapped = map;

    // Only update diagnostics for files we touched this run
    let runDiagnostics = 0;
    const ruleCounts: Record<string, number> = {};
    for (const [fp, results] of remapped.entries()) {
      const uri = vscode.Uri.file(fp);
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === fp
      );
      const diags = toDiagnostics(results, (rule) => ruleSeverity(rule, uri));
      const etag = docEtag(doc);
      publishDiagnostics(runId, uri, results, diags, etag);
      runDiagnostics += results.length;
      if (verboseLogging) {
        for (const r of results) {
          ruleCounts[r.rule] = (ruleCounts[r.rule] ?? 0) + 1;
        }
      }
    }

    const total = Array.from(diagCache.values()).reduce(
      (n, e) => n + e.diags.length,
      0
    );
    const duration = Date.now() - t0;
    log.appendLine(
      `Linted ${remapped.size} files (entries=${entries.length}) in ${duration}ms. Total diagnostics now ${total}.`
    );
    verboseEvent({
      event: "lintRunComplete",
      scope: "entries",
      runId,
      fileCount: remapped.size,
      diagnosticsPublished: runDiagnostics,
      durationMs: duration,
      finishedAt: new Date().toISOString(),
      ruleCounts: verboseLogging ? ruleCounts : undefined,
    });
  }

  async function lintDocumentBuffer(doc: vscode.TextDocument) {
    const runId = ++globalRunId;
    const t0 = Date.now();
    verboseEvent({
      event: "lintRunStart",
      scope: "documentBuffer",
      runId,
      filePath: doc.uri.fsPath,
      etag: docEtag(doc),
      startedAt: new Date(t0).toISOString(),
    });

    try {
      const documentCore = new ProjectLinter(buildOptions(doc.uri));
      const documentMap = await documentCore.lintFile(
        doc.uri.fsPath,
        doc.getText()
      );
      const filtered = buildRemappedResults(
        await applyInlineControls(
          documentMap,
          new Map([[path.resolve(doc.uri.fsPath).toLowerCase(), doc.getText()]])
        )
      );
      const results = stableSort(filtered.get(doc.uri.fsPath) ?? []);

      if (runId !== globalRunId) {
        verboseEvent({
          event: "lintRunDiscarded",
          scope: "documentBuffer",
          runId,
          stage: "postCompute",
        });
        return;
      }

      const diags = toDiagnostics(results, (rule) => ruleSeverity(rule, doc.uri));
      publishDiagnostics(runId, doc.uri, results, diags, docEtag(doc));
      log.appendLine(
        `Linted unsaved buffer ${path.basename(doc.uri.fsPath)} in ${
          Date.now() - t0
        }ms. Diagnostics: ${results.length}.`
      );
      verboseEvent({
        event: "lintRunComplete",
        scope: "documentBuffer",
        runId,
        filePath: doc.uri.fsPath,
        diagnosticsPublished: results.length,
        durationMs: Date.now() - t0,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[ZemDomu] buffer lint error:", error);
      log.appendLine(
        `Buffer lint failed for ${doc.uri.fsPath}: ${
          error instanceof Error ? error.stack ?? error.message : String(error)
        }`
      );
    }
  }

  async function lintWorkspaceAtomic(): Promise<WorkspaceScanOutcome> {
    let scanOutcome: WorkspaceScanOutcome | undefined;
    const reportProgress = (message: string, completion: number) => {
      const update = {
        message,
        completion: Math.max(0, Math.min(100, completion)),
      };
      issueTracker.updateScanPhase(message);
      for (const listener of workspaceProgressListeners) listener(update);
    };

    issueTracker.beginScan("Discovering supported workspace files.");
    reportProgress("Discovering supported workspace files...", 0);
    try {
      const include = "**/*.{html,jsx,tsx,vue}";
      const exclude = "{**/node_modules/**,**/dist/**,**/out/**,**/.git/**}";

      const runId = ++globalRunId; // guard for the entire workspace op
      const startedAt = Date.now();
      verboseEvent({
        event: "lintRunStart",
        scope: "workspace",
        runId,
        startedAt: new Date(startedAt).toISOString(),
        includePattern: include,
        excludePattern: exclude,
      });

      const files = await vscode.workspace.findFiles(include, exclude);
      if (runId !== globalRunId) {
        verboseEvent({
          event: "lintRunDiscarded",
          scope: "workspace",
          runId,
          stage: "postFileEnumeration",
        });
        reportProgress(
          "Workspace scan superseded by newer lint results.",
          100
        );
        scanOutcome = "superseded";
        return scanOutcome; // lost the race
      }
      verboseEvent({
        event: "lintRunEnumerated",
        scope: "workspace",
        runId,
        fileCount: files.length,
        samples: verboseLogging
          ? files.slice(0, 5).map((f) => f.toString())
          : undefined,
      });

      const groupCount = groupLintEntries(files).length;
      const fileLabel = files.length === 1 ? "file" : "files";
      const groupLabel = groupCount === 1
        ? "workspace folder"
        : "workspace folders";
      reportProgress(
        files.length === 0
          ? "No supported files found; preparing diagnostic cleanup..."
          : `Preparing to analyze ${files.length} ${fileLabel} across ${groupCount} ${groupLabel}...`,
        15
      );

      const t0 = Date.now();
      const map = await lintProjectGroups(files, (groupProgress) => {
        const completed = groupProgress.completedGroups;
        const total = Math.max(1, groupProgress.totalGroups);
        const completion = 15 + Math.round((completed / total) * 70);
        const currentFileLabel = groupProgress.currentGroupFiles === 1
          ? "file"
          : "files";
        const message = completed < groupProgress.currentGroup
          ? `Analyzing workspace folder ${groupProgress.currentGroup} of ${groupProgress.totalGroups} (${groupProgress.currentGroupFiles} ${currentFileLabel})...`
          : `Analyzed workspace folder ${groupProgress.currentGroup} of ${groupProgress.totalGroups}.`;
        reportProgress(message, completion);
      });
      if (runId !== globalRunId) {
        verboseEvent({
          event: "lintRunDiscarded",
          scope: "workspace",
          runId,
          stage: "postCompute",
        });
        reportProgress(
          "Workspace scan superseded by newer lint results.",
          100
        );
        scanOutcome = "superseded";
        return scanOutcome; // lost after compute
      }

      const remapped = map;

      reportProgress(
        `Publishing diagnostics for ${remapped.size} analyzed ${remapped.size === 1 ? "file" : "files"}...`,
        90
      );

      // Apply atomically: delete stale, then set new
      const updatedFiles = new Set(remapped.keys());

      // Remove stale files we previously owned but didn't touch this run
      for (const fp of Array.from(diagCache.keys())) {
        if (!updatedFiles.has(fp)) {
          const uri = vscode.Uri.file(fp);
          diagnostics.delete(uri);
          diagCache.delete(fp);
          issueTracker.removeFile(uri);
        }
      }

      // Apply new diags
      let runDiagnostics = 0;
      const ruleCounts: Record<string, number> = {};
      for (const [fp, results] of remapped.entries()) {
        const uri = vscode.Uri.file(fp);
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.fsPath === fp
        );
        const diags = toDiagnostics(results, (rule) => ruleSeverity(rule, uri));
        const etag = docEtag(doc);
        publishDiagnostics(runId, uri, results, diags, etag);
        runDiagnostics += results.length;
        if (verboseLogging) {
          for (const r of results) {
            ruleCounts[r.rule] = (ruleCounts[r.rule] ?? 0) + 1;
          }
        }
      }

      const total = Array.from(diagCache.values()).reduce(
        (n, e) => n + e.diags.length,
        0
      );
      const dt = Date.now() - t0;
      log.appendLine(
        `Workspace lint: ${remapped.size} files in ${dt}ms. Total diagnostics now ${total}.`
      );
      verboseEvent({
        event: "lintRunComplete",
        scope: "workspace",
        runId,
        fileCount: remapped.size,
        diagnosticsPublished: runDiagnostics,
        durationMs: dt,
        finishedAt: new Date().toISOString(),
        ruleCounts: verboseLogging ? ruleCounts : undefined,
      });

      const totalDuration = Date.now() - startedAt;
      reportProgress(
        `Complete: scanned ${files.length} ${fileLabel} and found ${runDiagnostics} ${runDiagnostics === 1 ? "issue" : "issues"} in ${totalDuration}ms.`,
        100
      );
      scanOutcome = "completed";

      if (cfg().get("devMode", false) as boolean) {
        const metrics = PerformanceDiagnostics.getLatestMetrics();
        let slowFile = "";
        let slowTime = 0;
        let slowPhase = "";
        let slowPhaseTime = 0;
        for (const [file, times] of metrics.entries()) {
          if ((times.total ?? 0) > slowTime) {
            slowTime = times.total ?? 0;
            slowFile = file;
          }
          for (const [ph, t] of Object.entries(times)) {
            if (ph !== "total" && t > slowPhaseTime) {
              slowPhaseTime = t;
              slowPhase = ph;
            }
          }
        }
        perfDiagnostics.log(
          `Slowest file: ${path.basename(slowFile)} ${slowTime.toFixed(2)}ms`
        );
        perfDiagnostics.log(
          `Slowest phase: ${slowPhase} ${slowPhaseTime.toFixed(2)}ms`
        );
      }
      return scanOutcome;
    } catch (error) {
      const details =
        error instanceof Error ? error.stack ?? error.message : String(error);
      log.appendLine(`Workspace scan failed: ${details}`);
      verboseEvent({
        event: "lintRunFailed",
        scope: "workspace",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (scanOutcome === "completed") {
        issueTracker.finishScan();
      } else if (scanOutcome === "superseded") {
        issueTracker.supersedeScan();
      } else {
        issueTracker.failScan(
          "The scan did not complete. Last-known diagnostics were preserved; see the ZemDomu output channel for details."
        );
      }
    }
  }

  async function lintSingle(doc: vscode.TextDocument) {
    const isSupported = ["html", "javascriptreact", "typescriptreact", "vue"].includes(
      doc.languageId
    );
    if (!isSupported) return;
    await lintEntries([doc.uri]);
  }

  /** Auto-run wiring */
  let saveDisp: vscode.Disposable | undefined;
  let typeDisp: vscode.Disposable | undefined;
  let typeTimer: NodeJS.Timeout | undefined;

  function scheduleWorkspaceLint() {
    return queueWorkspace(lintWorkspaceAtomic);
  }

  function updateListeners() {
    saveDisp?.dispose();
    typeDisp?.dispose();
    if (typeTimer) {
      clearTimeout(typeTimer);
      typeTimer = undefined;
    }

    const mode = cfg().get("run", "onSave") as
      | "onSave"
      | "onType"
      | "manual"
      | "disabled";

    if (mode === "onSave") {
      saveDisp = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        await lintSingle(doc);
      });
    } else if (mode === "onType") {
      typeDisp = vscode.workspace.onDidChangeTextDocument((evt) => {
        clearTimeout(typeTimer as any);
        typeTimer = setTimeout(async () => {
          await lintDocumentBuffer(evt.document);
        }, 150); // tweakable debounce
      });
    } else {
      log.appendLine(`Auto-lint disabled (${mode} mode).`);
    }
  }

  /** Command: Scan Workspace */
  const lintCommand = vscode.commands.registerCommand(
    "zemdomu.lintWorkspace",
    () => {
      if (activeWorkspaceCommand) return activeWorkspaceCommand;

      const command = vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "ZemDomu: Scan workspace",
          cancellable: false,
        },
        async (progress) => {
          let reportedCompletion = 0;
          const progressListener = (update: WorkspaceScanProgress) => {
            const nextCompletion = Math.max(
              reportedCompletion,
              update.completion
            );
            progress.report({
              message: update.message,
              increment: nextCompletion - reportedCompletion,
            });
            reportedCompletion = nextCompletion;
          };
          workspaceProgressListeners.add(progressListener);
          progressListener({
            message: runningWorkspace
              ? "Waiting for the active workspace scan to finish..."
              : "Starting workspace scan...",
            completion: 0,
          });
          const slow = setTimeout(
            () =>
              vscode.window.showInformationMessage(
                "ZemDomu is scanning the workspace..."
              ),
            5000
          );
          try {
            let scanOutcome: WorkspaceScanOutcome = "completed";
            scheduleWorkspaceLint();
            // Wait for the currently running/queued scan to finish if any.
            // Retain the first error so a queued retry cannot mask failure.
            let scanError: unknown;
            while (runningWorkspace) {
              try {
                scanOutcome = await runningWorkspace;
              } catch (error) {
                scanError ??= error;
              }
            }
            if (scanError) throw scanError;
            return scanOutcome === "superseded"
              ? "Scan superseded"
              : "Scan complete";
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            await vscode.window.showErrorMessage(
              `ZemDomu scan failed: ${message}. See the ZemDomu output channel for details.`
            );
            throw error;
          } finally {
            clearTimeout(slow);
            workspaceProgressListeners.delete(progressListener);
          }
        }
      );
      const trackedCommand = command.finally(() => {
        if (activeWorkspaceCommand === trackedCommand) {
          activeWorkspaceCommand = null;
        }
      });
      activeWorkspaceCommand = trackedCommand;
      return trackedCommand;
    }
  );

  /** React to settings changes */
  const configWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (!e.affectsConfiguration("zemdomu")) return;

    if (e.affectsConfiguration("zemdomu.devMode")) {
      const now = cfg().get("devMode", false) as boolean;
      perfDiagnostics.updateDevMode(now);
    }

    if (e.affectsConfiguration("zemdomu.enableVerboseLogging")) {
      verboseLogging = cfg().get("enableVerboseLogging", false) as boolean;
      log.appendLine(`Verbose logging ${verboseLogging ? "enabled" : "disabled"}.`);
    }

    // Rebuild the linter and rewire events. Each run mode waits for its own
    // public trigger; configuration changes must not launch an implicit scan.
    rebuildCore();
    updateListeners();
  });

  const actionProvider = vscode.languages.registerCodeActionsProvider(
    ["html", "javascriptreact", "typescriptreact", "vue"],
    new ZemCodeActionProvider(),
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  );

  context.subscriptions.push(
    diagnostics,
    lintCommand,
    configWatcher,
    actionProvider,
    issueTracker,
    { dispose: () => saveDisp?.dispose() },
    { dispose: () => typeDisp?.dispose() },
    {
      dispose: () => {
        if (typeTimer) clearTimeout(typeTimer);
      },
    },
    log
  );

  updateListeners();

  log.appendLine("ZemDomu extension activated");
  console.log("ZemDomu extension is now active");
}

export function deactivate() {
  console.log("ZemDomu extension is deactivated");
}
