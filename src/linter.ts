// src/linter.ts
import { Parser } from 'htmlparser2';

interface LintResult {
  line: number;
  column: number;
  message: string;
}

export function lintHtml(html: string): LintResult[] {
  const results: LintResult[] = [];
  const tagStack: { tag: string; line: number; column: number }[] = [];
  let lastHeadingLevel = 0;
  let h1Count = 0;
  const sectionStack: { foundHeading: boolean; line: number; column: number }[] = [];
  const anchorStack: { foundText: boolean; line: number; column: number }[] = [];
  const tableStack: { foundCaption: boolean; line: number; column: number }[] = [];
  const emptyTagStack: { tag: string; foundText: boolean; line: number; column: number }[] = [];

  // For form label rule
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
        if (anchorStack.length > 0 && text.trim().length > 0) {
          anchorStack[anchorStack.length - 1].foundText = true;
        }
        if (emptyTagStack.length > 0 && text.trim().length > 0) {
          emptyTagStack[emptyTagStack.length - 1].foundText = true;
        }
      },

      onopentag(name: string, attribs: { [key: string]: string }) {
        const tagPos = { tag: name, line: currentLine, column: currentColumn };
        tagStack.push(tagPos);

        if (ignoreNext) {
          ignoreNext = false;
          return;
        }

        // Collect <label for="..."> values
        if (name === 'label') {
          const forId = attribs.for;
          if (forId) labelFors.add(forId);
        }

        // Rule: form controls need label or aria
        if (['input', 'select', 'textarea'].includes(name)) {
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

        // Other rules
        if (name === 'h1') {
          h1Count++;
          if (h1Count > 1) {
            results.push({ line: tagPos.line, column: tagPos.column, message: 'Only one <h1> allowed per document' });
          }
        }
        if (name === 'li') {
          const parent = tagStack[tagStack.length - 2];
          if (!parent || (parent.tag !== 'ul' && parent.tag !== 'ol')) {
            results.push({ line: tagPos.line, column: tagPos.column, message: '<li> must be inside a <ul> or <ol>' });
          }
        }
        if (/^h[1-6]$/.test(name)) {
          const level = parseInt(name[1], 10);
          if (sectionStack.length > 0) sectionStack[sectionStack.length - 1].foundHeading = true;
          if (lastHeadingLevel !== 0 && level > lastHeadingLevel + 1) {
            results.push({ line: tagPos.line, column: tagPos.column, message: `⚠️ Heading level skipped: Found <${name}> after <h${lastHeadingLevel}>` });
          }
          lastHeadingLevel = level;
        }
        if (name === 'img') {
          const alt = attribs.alt;
          if (alt === undefined || alt.trim() === '') {
            results.push({ line: tagPos.line, column: tagPos.column, message: '<img> tag missing non-empty alt attribute' });
          }
        }
        if (name === 'a') {
          const href = attribs.href;
          anchorStack.push({ foundText: false, line: tagPos.line, column: tagPos.column });
          if (!href || href.trim() === '') {
            results.push({ line: tagPos.line, column: tagPos.column, message: '<a> tag missing non-empty href attribute' });
          }
        }
        if (name === 'table') {
          tableStack.push({ foundCaption: false, line: tagPos.line, column: tagPos.column });
        }
        if (name === 'caption' && tableStack.length > 0) {
          tableStack[tableStack.length - 1].foundCaption = true;
        }
        if (inlineEmptyTags.has(name)) {
          emptyTagStack.push({ tag: name, foundText: false, line: tagPos.line, column: tagPos.column });
        }
        if (name === 'section') {
          sectionStack.push({ foundHeading: false, line: tagPos.line, column: tagPos.column });
        }
      },

      onclosetag(name: string) {
        tagStack.pop();
        if (inlineEmptyTags.has(name)) {
          const emptyTag = emptyTagStack.pop();
          if (emptyTag && !emptyTag.foundText) {
            results.push({ line: emptyTag.line, column: emptyTag.column, message: `<${name}> tag should not be empty` });
          }
        }
        if (name === 'a') {
          const a = anchorStack.pop();
          if (a && !a.foundText) {
            results.push({ line: a.line, column: a.column, message: '<a> tag missing link text' });
          }
        }
        if (name === 'section') {
          const sec = sectionStack.pop();
          if (sec && !sec.foundHeading) {
            results.push({ line: sec.line, column: sec.column, message: '<section> missing heading (<h1>-<h6>)' });
          }
        }
        if (name === 'table') {
          const tbl = tableStack.pop();
          if (tbl && !tbl.foundCaption) {
            results.push({ line: tbl.line, column: tbl.column, message: '<table> missing <caption>' });
          }
        }
      }
    },
    { decodeEntities: true, xmlMode: false, recognizeSelfClosing: true }
  );

  parser.write(html);
  parser.end();

  return results;
}
