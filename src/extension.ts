import * as vscode from "vscode";
import * as path from "path";

import { ProjectLinter } from "zemdomu";
import type { ProjectLinterOptions, LintResult } from "zemdomu";

import { PerformanceDiagnostics } from "./performance-diagnostics";
import { IssueTracker } from "./issue-tracker";

/**
 * Race-safe, queued, and atomic application of diagnostics.
 * - Serializes workspace scans to avoid overlapping clears/applies
 * - Uses runId guards for compute and apply
 * - Avoids diagnostics.clear() upfront; surgically removes stale files
 * - Defers initial full scan in onSave mode to avoid colliding with first save
 */

type FileCacheEntry = {
  etag: string | null;
  diags: vscode.Diagnostic[];
};

type LintResultWithCode = LintResult & { code?: string };

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
  "preventZemdomuPlaceholders",
] as const;

const DOCS_RULES = new Set<string>(RULE_NAMES);

const QUICK_FIX_PLACEHOLDER = "TODO-ZMD";

const diagCache = new Map<string, FileCacheEntry>();

// Monotonic run ids to drop stale async results
let globalRunId = 0;

// Simple serialization for workspace-wide runs
let runningWorkspace: Promise<void> | null = null;
let workspaceQueued = false;

function queueWorkspace(run: () => Promise<void>) {
  if (runningWorkspace) {
    workspaceQueued = true;
    return;
  }
  runningWorkspace = (async () => {
    try {
      await run();
    } finally {
      runningWorkspace = null;
      if (workspaceQueued) {
        workspaceQueued = false;
        queueWorkspace(run);
      }
    }
  })();
}

// Create a stable signature for a LintResult
function keyLint(r: LintResult): string {
  const line = Number.isFinite(r.line) ? r.line : 0;
  const col = Number.isFinite(r.column) ? r.column : 0;
  return `${r.rule}|${line}|${col}|${r.message}`;
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
  return [...keys.slice(0, 3), "ΓÇª", ...keys.slice(-3)];
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

function extractTagName(lineText: string, startChar: number): string | null {
  const slice = lineText.slice(startChar);
  const match = slice.match(/<\s*([A-Za-z][\w:-]*)/);
  return match ? match[1] : null;
}

function findTabindexValueRange(
  lineText: string,
  lineNumber: number
): { range: vscode.Range } | null {
  const attrMatch = /tabindex\s*=\s*/i.exec(lineText);
  if (!attrMatch || attrMatch.index === undefined) return null;
  const valueStart = attrMatch.index + attrMatch[0].length;
  if (valueStart >= lineText.length) return null;

  const firstChar = lineText[valueStart];
  if (firstChar === '"' || firstChar === "'") {
    const end = lineText.indexOf(firstChar, valueStart + 1);
    if (end === -1) return null;
    return {
      range: new vscode.Range(
        new vscode.Position(lineNumber, valueStart + 1),
        new vscode.Position(lineNumber, end)
      ),
    };
  }

  if (firstChar === "{") {
    const end = lineText.indexOf("}", valueStart + 1);
    if (end === -1) return null;
    return {
      range: new vscode.Range(
        new vscode.Position(lineNumber, valueStart + 1),
        new vscode.Position(lineNumber, end)
      ),
    };
  }

  let end = lineText.length;
  for (let i = valueStart; i < lineText.length; i++) {
    const ch = lineText[i];
    if (/\s/.test(ch) || ch === ">" || ch === "/") {
      end = i;
      break;
    }
  }

  if (end <= valueStart) return null;
  return {
    range: new vscode.Range(
      new vscode.Position(lineNumber, valueStart),
      new vscode.Position(lineNumber, end)
    ),
  };
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
    const end = text.indexOf(">", idx);
    if (end === -1) return null;
    return { name, start: idx, end, text: text.slice(idx, end + 1) };
  };

  for (let i = Math.min(offset, text.length - 1); i >= 0; i--) {
    if (text[i] !== "<") continue;
    const tag = matchTagAt(i);
    if (tag) return tag;
  }

  const forward = text.slice(offset).match(/<\s*(input|select|textarea)\b[^>]*>/i);
  if (forward && forward.index !== undefined) {
    const start = offset + forward.index;
    const end = start + forward[0].length - 1;
    return { name: forward[1].toLowerCase(), start, end, text: forward[0] };
  }
  return null;
}

function parseTagAttributes(tagText: string): ParsedAttr[] {
  const tagMatch = tagText.match(/^<\s*([A-Za-z][\w:-]*)\b([^>]*)>/);
  if (!tagMatch) return [];
  const attrPart = tagMatch[2] ?? "";
  const attrOffset = tagMatch[0].indexOf(attrPart);
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
    const end = text.indexOf(">", absStart);
    if (end === -1) return null;
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
  const end = text.indexOf(">", index);
  if (end === -1) return null;
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
    const tagEnd = text.indexOf(">", idx);
    if (tagEnd === -1 || tagEnd > end) return null;
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

        let startLine = diag.range.start.line;
        let endLine = diag.range.start.line;
        const startOffset = getOffsetAt(document, diag.range.start, docText);

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
        const line = document.lineAt(diag.range.start.line);
        const lineText = line.text;
        const gt = lineText.indexOf(">", diag.range.start.character);
        if (gt !== -1 && lineText[gt - 1] !== "/") {
          const baseIndent = lineText.match(/^\s*/)?.[0] ?? "";
          const insertPos = new vscode.Position(diag.range.start.line, gt + 1);
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
        const line = document.lineAt(diag.range.start.line);
        const lineText = line.text;
        const valueRange = findTabindexValueRange(
          lineText,
          diag.range.start.line
        );
        if (valueRange) {
          const editZero = new vscode.WorkspaceEdit();
          editZero.replace(document.uri, valueRange.range, "0");
          const actionZero = new vscode.CodeAction(
            'Set tabindex to "0"',
            vscode.CodeActionKind.QuickFix
          );
          actionZero.diagnostics = [diag];
          actionZero.edit = editZero;
          actions.push(actionZero);

          const editMinus = new vscode.WorkspaceEdit();
          editMinus.replace(document.uri, valueRange.range, "-1");
          const actionMinus = new vscode.CodeAction(
            'Set tabindex to "-1"',
            vscode.CodeActionKind.QuickFix
          );
          actionMinus.diagnostics = [diag];
          actionMinus.edit = editMinus;
          actions.push(actionMinus);
        }
      }

      if (isSingleH1Diagnostic(diag)) {
        const docText = document.getText();
        const startOffset = getOffsetAt(document, diag.range.start, docText);
        const openRegex = /<h1\b[^>]*>/gi;
        openRegex.lastIndex = startOffset;
        const openMatch = openRegex.exec(docText);
        if (openMatch) {
          const openStart = openMatch.index;
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
          closeRegex.lastIndex = openStart + openMatch[0].length;
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
            const openRegex = new RegExp(
              `<h${parsed.current}\\b[^>]*>`,
              "ig"
            );
            openRegex.lastIndex = startOffset;
            const openMatch = openRegex.exec(docText);
            if (openMatch) {
              const openStart = openMatch.index;
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
              closeRegex.lastIndex = openStart + openMatch[0].length;
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
        const tagEnd = docText.indexOf(">", sectionStart);
        if (tagEnd !== -1 && docText[tagEnd - 1] !== "/") {
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

      const line = document.lineAt(diag.range.start.line);
      const lineText = line.text;
      const gt = lineText.indexOf(">", diag.range.start.character);
      if (gt === -1) continue;

      const tagName = extractTagName(lineText, diag.range.start.character);
      const insertPos = new vscode.Position(
        diag.range.start.line,
        lineText[gt - 1] === "/" ? gt - 1 : gt
      );

      const addAttr = (
        title: string,
        snippet: string,
        match: (m: string) => boolean
      ) => {
        if (!match(diag.message)) return;
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, insertPos, ` ${snippet}`);
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
        `alt="${QUICK_FIX_PLACEHOLDER}"`,
        (m) => m.includes("img") && m.includes("alt")
      );
      if (diag.message.includes("href attribute")) {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, insertPos, ` href="${QUICK_FIX_PLACEHOLDER}"`);
        const action = new vscode.CodeAction(
          `Add href="${QUICK_FIX_PLACEHOLDER}"`,
          vscode.CodeActionKind.QuickFix
        );
        action.diagnostics = [diag];
        action.edit = edit;
        actions.push(action);

        if (tagName && tagName.toLowerCase() !== "a") {
          const toEdit = new vscode.WorkspaceEdit();
          toEdit.insert(document.uri, insertPos, ` to="${QUICK_FIX_PLACEHOLDER}"`);
          const toAction = new vscode.CodeAction(
            `Add to="${QUICK_FIX_PLACEHOLDER}"`,
            vscode.CodeActionKind.QuickFix
          );
          toAction.diagnostics = [diag];
          toAction.edit = toEdit;
          actions.push(toAction);
        }
      }
      if (diag.message.includes("missing <caption>")) {
        const capPos = new vscode.Position(diag.range.start.line, gt + 1);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(
          document.uri,
          capPos,
          `\n  <caption>${QUICK_FIX_PLACEHOLDER}</caption>`
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
        `title="${QUICK_FIX_PLACEHOLDER}"`,
        (m) =>
          m.includes("missing title attribute") ||
          m.includes("title attribute is empty")
      );
      addAttr(
        `Add lang="${QUICK_FIX_PLACEHOLDER}"`,
        `lang="${QUICK_FIX_PLACEHOLDER}"`,
        (m) =>
          m.includes("missing lang attribute") ||
          m.includes("lang attribute is empty")
      );
      addAttr(
        `Add aria-label="${QUICK_FIX_PLACEHOLDER}"`,
        `aria-label="${QUICK_FIX_PLACEHOLDER}"`,
        (m) =>
          m.includes("accessible text") ||
          m.includes("aria-label attribute is empty")
      );
      addAttr(
        `Add alt="${QUICK_FIX_PLACEHOLDER}"`,
        `alt="${QUICK_FIX_PLACEHOLDER}"`,
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
  const cfg = () => vscode.workspace.getConfiguration("zemdomu");

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

  // Single ProjectLinter instance, rebuilt when settings change
  let core: ProjectLinter | null = null;
  let workspaceLinted = false;

  function buildOptions(): ProjectLinterOptions {
    const c = cfg();

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

    const crossComponentAnalysis = c.get(
      "crossComponentAnalysis",
      true
    ) as boolean;
    const crossComponentDepth = c.get("crossComponentDepth", 50) as number;
    const rootOverride = (c.get("rootDir", "") as string) || "";
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const rootDir = rootOverride || workspaceRoot || process.cwd();

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

  function ruleSeverity(rule: string): vscode.DiagnosticSeverity {
    const sev = cfg().get(`severity.${rule}`, "warning") as "warning" | "error";
    return sev === "error"
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning;
  }

  function rebuildCore() {
    core = new ProjectLinter(buildOptions());
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

    // Dedupe + stable order per file (preserve empty entries for clearing diagnostics)
    const out = new Map<string, LintResult[]>();
    for (const [fp, results] of remapped.entries()) {
      const seen = new Set<string>();
      const unique: LintResult[] = [];
      for (const r of stableSort(results)) {
        const k = keyLint(r);
        if (!seen.has(k)) {
          seen.add(k);
          unique.push(r);
        }
      }
      out.set(fp, unique);
    }

    return out;
  }

  async function lintEntries(entryUris: vscode.Uri[]) {
    if (!core) rebuildCore();

    const entries = entryUris
      .map((u) => u.fsPath)
      .filter(
        (p) =>
          !/[\\/]node_modules[\\/]/.test(p) && !/[\\/](dist|out)[\\/]/.test(p)
      );

    if (entries.length === 0 || !core) return;

    const runId = ++globalRunId; // snapshot run id for this pass
    const thisCore = core; // snapshot core to avoid mid-run swaps
    const t0 = Date.now();
    verboseEvent({
      event: "lintRunStart",
      scope: "entries",
      runId,
      entryCount: entries.length,
      startedAt: new Date(t0).toISOString(),
      uris: verboseLogging ? entryUris.map((u) => u.toString()) : undefined,
    });

    const map = await thisCore!.lintFiles(entries).catch((e) => {
      console.error("[ZemDomu] lintFiles error:", e);
      return new Map<string, LintResult[]>();
    });

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

    const remapped = buildRemappedResults(map);

    // Only update diagnostics for files we touched this run
    let runDiagnostics = 0;
    const ruleCounts: Record<string, number> = {};
    for (const [fp, results] of remapped.entries()) {
      const uri = vscode.Uri.file(fp);
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === fp
      );
      const diags = toDiagnostics(results, ruleSeverity);
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

  async function lintWorkspaceAtomic() {
    issueTracker.beginScan("Scanning workspace for ZemDomu issues...");
    try {
      core?.clear();

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
        return; // lost the race
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

      const t0 = Date.now();
      const thisCore = core ?? new ProjectLinter(buildOptions());
      const map = await thisCore
        .lintFiles(files.map((f) => f.fsPath))
        .catch(() => new Map<string, LintResult[]>());
      if (runId !== globalRunId) {
        verboseEvent({
          event: "lintRunDiscarded",
          scope: "workspace",
          runId,
          stage: "postCompute",
        });
        return; // lost after compute
      }

      const remapped = buildRemappedResults(map);

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
        const diags = toDiagnostics(results, ruleSeverity);
        const etag = docEtag(doc);
        publishDiagnostics(runId, uri, results, diags, etag);
        runDiagnostics += results.length;
        if (verboseLogging) {
          for (const r of results) {
            ruleCounts[r.rule] = (ruleCounts[r.rule] ?? 0) + 1;
          }
        }
      }

      workspaceLinted = true;

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
    } finally {
      issueTracker.finishScan();
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
    queueWorkspace(lintWorkspaceAtomic);
  }

  function updateListeners() {
    saveDisp?.dispose();
    typeDisp?.dispose();

    const mode = cfg().get("run", "onSave") as
      | "onSave"
      | "onType"
      | "manual"
      | "disabled";

    if (mode === "onSave") {
      saveDisp = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (workspaceLinted) await lintSingle(doc);
        else scheduleWorkspaceLint();
      });
    } else if (mode === "onType") {
      typeDisp = vscode.workspace.onDidChangeTextDocument((evt) => {
        clearTimeout(typeTimer as any);
        typeTimer = setTimeout(async () => {
          if (workspaceLinted) await lintSingle(evt.document);
          else scheduleWorkspaceLint();
        }, 150); // tweakable debounce
      });
    } else {
      log.appendLine("Auto-lint disabled (manual mode).");
    }
  }

  /** Command: Scan Workspace */
  const lintCommand = vscode.commands.registerCommand(
    "zemdomu.lintWorkspace",
    () => {
      return vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "ZemDomu: ScanningΓÇª",
          cancellable: false,
        },
        async (progress) => {
          const slow = setTimeout(
            () =>
              vscode.window.showInformationMessage(
                "ZemDomu is scanning the workspaceΓÇª"
              ),
            5000
          );
          progress.report({ increment: 0 });
          scheduleWorkspaceLint();
          // Wait for the currently running/queued scan to finish if any
          while (runningWorkspace) {
            try {
              await runningWorkspace;
            } catch {}
          }
          clearTimeout(slow);
          progress.report({ increment: 100 });
          return "Scan complete";
        }
      );
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

    // Rebuild linter with new options and relint
    rebuildCore();
    updateListeners();
    scheduleWorkspaceLint();
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
    log
  );

  updateListeners();

  // First pass after a short delay, but only if not onSave mode to avoid collision with first save
  const mode = cfg().get("run", "onSave") as
    | "onSave"
    | "onType"
    | "manual"
    | "disabled";
  if (mode !== "onSave") {
    setTimeout(() => {
      scheduleWorkspaceLint();
    }, 750);
  }

  log.appendLine("ZemDomu extension activated");
  console.log("ZemDomu extension is now active");
}

export function deactivate() {
  console.log("ZemDomu extension is deactivated");
}
