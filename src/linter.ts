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
    console.log(results);

  let currentLine = 0;
  let currentColumn = 0;

  const parser = new Parser(
    {
      ontext(text: string) {
        // Track new lines in text nodes
        const lines = text.split("\n");
        if (lines.length > 1) {
          currentLine += lines.length - 1;
          currentColumn = lines[lines.length - 1].length;
        } else {
          currentColumn += text.length;
        }
      },

      onopentag(name: string) {
        const currentTag = {
          tag: name,
          line: currentLine,
          column: currentColumn,
        };

        tagStack.push(currentTag);

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
      },

      onclosetag() {
        tagStack.pop();
      }
    },
    { decodeEntities: true, xmlMode: false, recognizeSelfClosing: true }
  );

  parser.write(html);
  parser.end();

  return results;
}
