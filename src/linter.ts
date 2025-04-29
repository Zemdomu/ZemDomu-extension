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
  let ignoreNext = false;

  let currentLine = 0;
  let currentColumn = 0;

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
      },

      onopentag(name: string, attribs: { [key: string]: string }) {
        const tagPos = { tag: name, line: currentLine, column: currentColumn };
        tagStack.push(tagPos);

        if (ignoreNext) {
          ignoreNext = false;
          return;
        }

        // Track <table> context for caption rule
        if (name === 'table') {
          tableStack.push({ foundCaption: false, line: tagPos.line, column: tagPos.column });
        }
        // Mark when we see <caption> inside a table
        if (name === 'caption' && tableStack.length > 0) {
          tableStack[tableStack.length - 1].foundCaption = true;
        }

        // Rule: Only one <h1> per document
        if (name === 'h1') {
          h1Count++;
          if (h1Count > 1) {
            results.push({ line: tagPos.line, column: tagPos.column, message: 'Only one <h1> allowed per document' });
          }
        }

        // Rule: <li> must be inside <ul> or <ol>
        if (name === 'li') {
          const parent = tagStack[tagStack.length - 2];
          if (!parent || (parent.tag !== 'ul' && parent.tag !== 'ol')) {
            results.push({ line: tagPos.line, column: tagPos.column, message: '<li> must be inside a <ul> or <ol>' });
          }
        }

        // Rule: Heading order (no skipping levels)
        if (/^h[1-6]$/.test(name)) {
          const level = parseInt(name[1], 10);
          if (sectionStack.length > 0) {
            sectionStack[sectionStack.length - 1].foundHeading = true;
          }
          if (lastHeadingLevel !== 0 && level > lastHeadingLevel + 1) {
            results.push({ line: tagPos.line, column: tagPos.column, message: `⚠️ Heading level skipped: Found <${name}> after <h${lastHeadingLevel}>` });
          }
          lastHeadingLevel = level;
        }

        // Rule: <img> must have non-empty alt
        if (name === 'img') {
          const alt = attribs.alt;
          if (alt === undefined || alt.trim() === '') {
            results.push({ line: tagPos.line, column: tagPos.column, message: '<img> tag missing non-empty alt attribute' });
          }
        }

        // Rule: <a> must have href and link text
        if (name === 'a') {
          const href = attribs.href;
          anchorStack.push({ foundText: false, line: tagPos.line, column: tagPos.column });
          if (!href || href.trim() === '') {
            results.push({ line: tagPos.line, column: tagPos.column, message: '<a> tag missing non-empty href attribute' });
          }
        }

        // Track <section>
        if (name === 'section') {
          sectionStack.push({ foundHeading: false, line: tagPos.line, column: tagPos.column });
        }
      },

      onclosetag(name: string) {
        tagStack.pop();

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

        // Rule: <table> must have <caption>
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
