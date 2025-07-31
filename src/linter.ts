import { lint, LinterOptions, LintResult } from 'zemdomu';

export type { LinterOptions, LintResult };

export function lintHtml(content: string, xmlMode = false, options: LinterOptions = {}): LintResult[] {
  const results = lint(content, options);
  const lines = content.split(/\r?\n/);
  const ignoreLines = new Set<number>();
  const ranges: Array<{start:number,end:number}> = [];
  let blockStart: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('zemdomu-disable-next')) {
      const after = line.split('zemdomu-disable-next')[1];
      if (after && after.trim()) {
        ignoreLines.add(i + 1);
      } else {
        ignoreLines.add(i + 2); // next line
      }
    } else if (line.includes('zemdomu-disable')) {
      blockStart = i + 1;
    } else if (line.includes('zemdomu-enable')) {
      if (blockStart !== null) {
        ranges.push({ start: blockStart, end: i + 1 });
        blockStart = null;
      }
    }
  }
  if (blockStart !== null) {
    ranges.push({ start: blockStart, end: Number.MAX_SAFE_INTEGER });
  }
  return results.filter(r => {
    const lineNum = r.line + 1;
    if (ignoreLines.has(lineNum)) return false;
    return !ranges.some(rng => lineNum >= rng.start && lineNum <= rng.end);
  });
}
