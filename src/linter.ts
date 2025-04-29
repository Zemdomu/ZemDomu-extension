// src/linter.ts
import { Parser } from 'htmlparser2';

interface LintResult {
  line: number;
  column: number;
  message: string;
}

/**
 * Lint HTML or JSX/TSX string for semantic issues.
 * @param html The content to lint.
 * @param xmlMode Whether to use XML mode (for JSX/TSX).
 */
export function lintHtml(html: string, xmlMode: boolean = false): LintResult[] {
  const results: LintResult[] = [];
  const tagStack: { tag: string; line: number; column: number }[] = [];
  let lastHeadingLevel = 0;
  let h1Count = 0;
  const sectionStack: { foundHeading: boolean; line: number; column: number }[] = [];
  const anchorStack: { foundText: boolean; line: number; column: number }[] = [];
  const tableStack: { foundCaption: boolean; line: number; column: number }[] = [];
  const emptyTagStack: { tag: string; foundText: boolean; line: number; column: number }[] = [];
  const labelFors = new Set<string>();

  let ignoreNext = false;
  let currentLine = 0;
  let currentColumn = 0;

  const inlineEmptyTags = new Set(['strong', 'em', 'b', 'i', 'u', 'small', 'mark', 'del', 'ins']);

  const parser = new Parser(
    {
      oncomment(data: string) {
        const text = data.trim();
        if (/^zemdomu-disable-next/.test(text)) {
          ignoreNext = true;
        }
      },

      ontext(text: string) {
        const lines = text.split("\n");
        if (lines.length > 1) {
          currentLine += lines.length - 1;
          currentColumn = lines[lines.length - 1].length;
        } else {
          currentColumn += text.length;
        }
        const trimmed = text.trim();
        if (anchorStack.length > 0 && trimmed.length > 0) {
          anchorStack[anchorStack.length - 1].foundText = true;
        }
        if (emptyTagStack.length > 0 && trimmed.length > 0) {
          emptyTagStack[emptyTagStack.length - 1].foundText = true;
        }
      },

      onopentag(name: string, attribs: { [key: string]: string }) {
        const tagName = name.toLowerCase();
        const tagPos = { tag: tagName, line: currentLine, column: currentColumn };
        tagStack.push(tagPos);

        if (ignoreNext) {
          ignoreNext = false;
          return;
        }

        if (tagName === 'label') {
          const forId = attribs.for;
          if (forId) labelFors.add(forId);
        }

        if (['input', 'select', 'textarea'].includes(tagName)) {
          const id = attribs.id;
          const aria = attribs['aria-label'];
          if (!aria || aria.trim() === '') {
            if (!id) {
              results.push({ line: tagPos.line, column: tagPos.column, message: 'Form control missing id or aria-label' });
            } else if (!labelFors.has(id)) {
              results.push({ line: tagPos.line, column: tagPos.column, message: `Form control with id="${id}" missing <label for=\"${id}\">` });
            }
          }
        }

        if (tagName === 'h1') {
          h1Count++;
          if (h1Count > 1) {
            results.push({ line: tagPos.line, column: tagPos.column, message: 'Only one <h1> allowed per document' });
          }
        }

        if (tagName === 'li') {
          const parent = tagStack[tagStack.length - 2];
          if (!parent || (parent.tag !== 'ul' && parent.tag !== 'ol')) {
            results.push({ line: tagPos.line, column: tagPos.column, message: '<li> must be inside a <ul> or <ol>' });
          }
        }

        if (/^h[1-6]$/.test(tagName)) {
          const level = parseInt(tagName.charAt(1), 10);
          if (sectionStack.length > 0) sectionStack[sectionStack.length - 1].foundHeading = true;
          if (lastHeadingLevel !== 0 && level > lastHeadingLevel + 1) {
            results.push({ line: tagPos.line, column: tagPos.column, message: `⚠️ Heading level skipped: Found <${tagName}> after <h${lastHeadingLevel}>` });
          }
          lastHeadingLevel = level;
        }

        if (tagName === 'img') {
          const alt = attribs.alt;
          if (alt === undefined || alt.trim() === '') {
            results.push({ line: tagPos.line, column: tagPos.column, message: '<img> tag missing non-empty alt attribute' });
          }
        }

        if (tagName === 'a') {
          const href = attribs.href;
          anchorStack.push({ foundText: false, line: tagPos.line, column: tagPos.column });
          if (!href || href.trim() === '') {
            results.push({ line: tagPos.line, column: tagPos.column, message: '<a> tag missing non-empty href attribute' });
          }
        }

        if (tagName === 'table') {
          tableStack.push({ foundCaption: false, line: tagPos.line, column: tagPos.column });
        }

        if (tagName === 'caption' && tableStack.length > 0) {
          tableStack[tableStack.length - 1].foundCaption = true;
        }

        if (inlineEmptyTags.has(tagName)) {
          emptyTagStack.push({ tag: tagName, foundText: false, line: tagPos.line, column: tagPos.column });
        }

        if (tagName === 'section') {
          sectionStack.push({ foundHeading: false, line: tagPos.line, column: tagPos.column });
        }
      },

      onclosetag(name: string) {
        const tagName = name.toLowerCase();
        tagStack.pop();

        if (inlineEmptyTags.has(tagName)) {
          const emptyTag = emptyTagStack.pop();
          if (emptyTag && !emptyTag.foundText) {
            results.push({ line: emptyTag.line, column: emptyTag.column, message: `<${tagName}> tag should not be empty` });
          }
        }

        if (tagName === 'a') {
          const a = anchorStack.pop();
          if (a && !a.foundText) {
            results.push({ line: a.line, column: a.column, message: '<a> tag missing link text' });
          }
        }

        if (tagName === 'section') {
          const sec = sectionStack.pop();
          if (sec && !sec.foundHeading) {
            results.push({ line: sec.line, column: sec.column, message: '<section> missing heading (<h1>-<h6>)' });
          }
        }

        if (tagName === 'table') {
          const tbl = tableStack.pop();
          if (tbl && !tbl.foundCaption) {
            results.push({ line: tbl.line, column: tbl.column, message: '<table> missing <caption>' });
          }
        }
      }
    },
    { decodeEntities: true, xmlMode, recognizeSelfClosing: true }
  );

  parser.write(html);
  parser.end();
  return results;
}
