// src/cross-remap.ts
import * as path from "path";
import type { LintResult } from "zemdomu";

export type Occurrence = {
  componentPath: string;
  componentName: string;
  line: number;
  column: number;
};

export type RemapOutput = {
  // file => adjusted lint results that should be shown under that file
  perFile: Map<string, LintResult[]>;
  // entryFile => occurrences for building a summary with related links
  summaries: Map<string, Occurrence[]>;
};

// naive <tag> finder to get a stable pointer; fine for tests
function findFirstTagPos(
  src: string,
  tag: string
): { line: number; col: number } {
  const idx = src.indexOf(`<${tag}`);
  if (idx < 0) return { line: 0, col: 0 };
  let line = 0,
    col = 0;
  for (let i = 0; i < idx; i++) {
    if (src.charCodeAt(i) === 10) {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}

/**
 * Cross-component remap:
 * - Moves cross-component singleH1/enforceHeadingOrder diagnostics to the component file
 * - Computes a reasonable <h1> position in the component for the diagnostic
 * - Returns per-file results and a summary list for each entry file
 */
export function remapCrossComponent(
  raw: Map<string, LintResult[]>,
  readFileSync: (absPath: string) => string
): RemapOutput {
  const perFile = new Map<string, LintResult[]>();
  const summaries = new Map<string, Occurrence[]>();

  // Build a quick index: ComponentName -> [absPaths]
  const nameIndex = new Map<string, string[]>();
  for (const fp of raw.keys()) {
    const base = path.basename(fp, path.extname(fp));
    const list = nameIndex.get(base) ?? [];
    list.push(fp);
    nameIndex.set(base, list);
  }

  for (const [entryPath, results] of raw.entries()) {
    for (const r of results) {
      const isCross =
        (r.rule === "singleH1" && /component/i.test(r.message)) ||
        (r.rule === "enforceHeadingOrder" &&
          /cross-component/i.test(r.message));

      if (!isCross) {
        const list = perFile.get(entryPath) ?? [];
        list.push(r);
        perFile.set(entryPath, list);
        continue;
      }

      const m = r.message.match(/component '([^']+)'/i);
      const compName = m?.[1];
      if (!compName) {
        const list = perFile.get(entryPath) ?? [];
        list.push(r);
        perFile.set(entryPath, list);
        continue;
      }

      const candidates = nameIndex.get(compName);
      if (!candidates || candidates.length !== 1) {
        const list = perFile.get(entryPath) ?? [];
        list.push(r);
        perFile.set(entryPath, list);
        continue;
      }

      const componentPath = candidates[0];
      const src = readFileSync(componentPath);
      const pos = findFirstTagPos(src, "h1");

      // push adjusted (remapped) diagnostic into the component file
      const adjusted: LintResult = {
        ...r,
        filePath: componentPath,
        line: pos.line,
        column: pos.col,
      };
      const tgtList = perFile.get(componentPath) ?? [];
      tgtList.push(adjusted);
      perFile.set(componentPath, tgtList);

      // record for summary on the entry file
      const occ: Occurrence = {
        componentPath,
        componentName: compName,
        line: pos.line,
        column: pos.col,
      };
      const occs = summaries.get(entryPath) ?? [];
      occs.push(occ);
      summaries.set(entryPath, occs);
    }
  }

  return { perFile, summaries };
}
