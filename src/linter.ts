import { lint, LinterOptions, LintResult } from "zemdomu";
import { parse as parseJs } from "@babel/parser";

export type { LinterOptions, LintResult };

type SourceRange = { start: number; end: number };
type OffsetRange = SourceRange & { rules: Set<string> | null };
type BlockControl = {
  action: "disable" | "enable";
  offset: number;
  rules: Set<string> | null;
};
type SourceComment = { body: string; start: number; end: number };

function jsxComments(content: string): SourceComment[] | null {
  try {
    const ast = parseJs(content, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      errorRecovery: true,
    }) as { comments?: Array<{ value: string; start?: number | null; end?: number | null }> };
    return (ast.comments ?? []).flatMap((comment) => {
      if (comment.start == null || comment.end == null) return [];
      if (content[comment.start - 1] !== "{" || content[comment.end] !== "}") {
        return [];
      }
      return [{
        body: comment.value,
        start: comment.start - 1,
        end: comment.end + 1,
      }];
    });
  } catch {
    return null;
  }
}

function tagEnd(text: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index + 1;
  }
  return text.length;
}

function htmlComments(content: string): SourceComment[] {
  const comments: SourceComment[] = [];
  let index = 0;
  while (index < content.length) {
    if (content.startsWith("<!--", index)) {
      const close = content.indexOf("-->", index + 4);
      const end = close === -1 ? content.length : close + 3;
      comments.push({
        body: content.slice(index + 4, close === -1 ? content.length : close),
        start: index,
        end,
      });
      index = end;
      continue;
    }
    if (content[index] !== "<") {
      index += 1;
      continue;
    }
    const open = /^<\s*(script|style|textarea|title|xmp|iframe|noembed|noframes)\b/i.exec(
      content.slice(index)
    );
    if (open) {
      const openEnd = tagEnd(content, index);
      const closePattern = new RegExp(`</\\s*${open[1]}\\s*>`, "ig");
      closePattern.lastIndex = openEnd;
      const close = closePattern.exec(content);
      index = close ? close.index + close[0].length : content.length;
      continue;
    }
    index = tagEnd(content, index);
  }
  return comments;
}

function sourceComments(content: string): SourceComment[] {
  return jsxComments(content) ?? htmlComments(content);
}

function rulesFromDirective(raw: string): Set<string> | null {
  const names = raw.trim().split(/[\s,]+/).filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
}

function appliesToRule(rules: Set<string> | null, rule: string): boolean {
  return rules === null || rules.has("*") || rules.has(rule);
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function offsetForResult(
  result: LintResult,
  starts: number[],
  textLength: number,
  content: string,
  inferenceCursors: Map<string, number>
): number {
  const absoluteOffset = (result as LintResult & { offset?: number }).offset;
  if (Number.isFinite(absoluteOffset)) {
    return Math.max(0, Math.min(textLength, absoluteOffset as number));
  }
  const line = Number.isFinite(result.line) ? Math.max(0, result.line) : 0;
  const column = Number.isFinite(result.column)
    ? Math.max(0, result.column)
    : 0;
  if (line === 0 && column === 0) {
    const tagName = /<([A-Za-z][\w:-]*)\b/.exec(result.message)?.[1];
    if (tagName) {
      const key = `${result.rule}\0${tagName.toLowerCase()}`;
      const cursor = inferenceCursors.get(key) ?? 0;
      const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tag = new RegExp(`<\\s*${escaped}\\b`, "ig");
      tag.lastIndex = cursor;
      const match = tag.exec(content);
      if (match) {
        inferenceCursors.set(key, tag.lastIndex);
        return match.index;
      }
    }
  }
  const lineStart = starts[Math.min(line, starts.length - 1)] ?? 0;
  return Math.min(textLength, lineStart + column);
}

function lineEnd(text: string, offset: number): number {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end;
}

function nextContentLineRange(text: string, offset: number): SourceRange | null {
  let start = offset;
  while (start < text.length) {
    const end = lineEnd(text, start);
    if (text.slice(start, end).trim().length > 0) return { start, end };
    start = end + 1;
  }
  return null;
}

/** Apply inline controls to findings returned by either lint or ProjectLinter. */
export function applyInlineDisableDirectives(
  content: string,
  results: LintResult[]
): LintResult[] {
  const disabledNext: OffsetRange[] = [];
  const blockControls: BlockControl[] = [];
  for (const comment of sourceComments(content)) {
    const directive = /^\s*zemdomu-(disable-next|disable|enable)\b([\s\S]*?)\s*$/i.exec(
      comment.body
    );
    if (!directive) continue;
    const action = directive[1] as "disable-next" | "disable" | "enable";
    const rules = rulesFromDirective(directive[2]);

    const commentStart = comment.start;
    const commentEnd = comment.end;
    if (action === "disable" || action === "enable") {
      blockControls.push({
        action,
        offset: action === "disable" ? commentEnd : commentStart,
        rules,
      });
      continue;
    }

    const currentLineEnd = lineEnd(content, commentEnd);
    if (content.slice(commentEnd, currentLineEnd).trim().length > 0) {
      disabledNext.push({ start: commentEnd, end: currentLineEnd, rules });
    } else {
      const target = nextContentLineRange(
        content,
        Math.min(content.length, currentLineEnd + 1)
      );
      if (target) disabledNext.push({ ...target, rules });
    }
  }

  if (disabledNext.length === 0 && blockControls.length === 0) return results;

  const starts = lineStarts(content);
  const inferenceCursors = new Map<string, number>();
  return results.filter((result) => {
    const offset = offsetForResult(
      result,
      starts,
      content.length,
      content,
      inferenceCursors
    );
    if (
      disabledNext.some(
        (range) =>
          offset >= range.start &&
          offset <= range.end &&
          appliesToRule(range.rules, result.rule)
      )
    ) {
      return false;
    }

    const disabledRules = new Set<string>();
    const enabledWhileAllDisabled = new Set<string>();
    let disableAll = false;
    for (const control of blockControls) {
      if (control.offset > offset) break;
      if (control.action === "disable") {
        if (control.rules === null || control.rules.has("*")) {
          disableAll = true;
          enabledWhileAllDisabled.clear();
        } else {
          for (const rule of control.rules) {
            disabledRules.add(rule);
            enabledWhileAllDisabled.delete(rule);
          }
        }
      } else if (control.rules === null || control.rules.has("*")) {
        disableAll = false;
        disabledRules.clear();
        enabledWhileAllDisabled.clear();
      } else {
        for (const rule of control.rules) {
          disabledRules.delete(rule);
          if (disableAll) enabledWhileAllDisabled.add(rule);
        }
      }
    }
    return !(
      disabledRules.has(result.rule) ||
      (disableAll && !enabledWhileAllDisabled.has(result.rule))
    );
  });
}

export function lintHtml(
  content: string,
  xmlMode = false,
  options: LinterOptions = {}
): LintResult[] {
  return applyInlineDisableDirectives(
    content,
    lint(content, { ...options, forceHtml: !xmlMode || options.forceHtml })
  );
}
