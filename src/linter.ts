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
  const sectionStack: { foundHeading: boolean; line: number; column: number }[] = [];

  let currentLine = 0;
  let currentColumn = 0;

  const parser = new Parser(
    {
      ontext(text: string) {
        const lines = text.split('\n');
        if (lines.length > 1) {
          currentLine += lines.length - 1;
          currentColumn = lines[lines.length - 1].length;
        } else {
          currentColumn += text.length;
        }
      },

      onopentag(name: string, attribs: { [key: string]: string }) {
        const currentTag = { tag: name, line: currentLine, column: currentColumn };
        tagStack.push(currentTag);

        // Track <section> context
        if (name === 'section') {
          sectionStack.push({ foundHeading: false, line: currentLine, column: currentColumn });
        }

        // Rule: <li> must be inside <ul> or <ol>
        if (name === 'li') {
          const parent = tagStack[tagStack.length - 2];
          if (!parent || (parent.tag !== 'ul' && parent.tag !== 'ol')) {
            results.push({
              line: currentTag.line,
              column: currentTag.column,
              message: '<li> must be inside a <ul> or <ol>'
            });
          }
        }

        // Rule: Heading order check (no skipping levels)
        if (/^h[1-6]$/.test(name)) {
          const headingLevel = parseInt(name.substring(1), 10);
          // Mark section has heading
          if (sectionStack.length > 0) {
            sectionStack[sectionStack.length - 1].foundHeading = true;
          }
          if (lastHeadingLevel !== 0 && headingLevel > lastHeadingLevel + 1) {
            results.push({
              line: currentTag.line,
              column: currentTag.column,
              message: `⚠️ Heading level skipped: Found <${name}> after <h${lastHeadingLevel}>`
            });
          }
          lastHeadingLevel = headingLevel;
        }

        // Rule: <img> must have alt attribute (non-empty)
        if (name === 'img') {
          const alt = attribs.alt;
          if (alt === undefined || alt.trim() === '') {
            results.push({
              line: currentTag.line,
              column: currentTag.column,
              message: '<img> tag missing non-empty alt attribute'
            });
          }
        }
      },

      onclosetag(name: string) {
        tagStack.pop();
        if (name === 'section') {
          const sec = sectionStack.pop();
          if (sec && !sec.foundHeading) {
            results.push({
              line: sec.line,
              column: sec.column,
              message: '<section> missing heading (<h1>-<h6>)'
            });
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
