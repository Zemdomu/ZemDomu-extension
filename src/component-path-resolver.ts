import * as vscode from 'vscode';
import * as path from 'path';

export class ComponentPathResolver {
  private static resolveCache = new Map<string, string | null>();
  private static statCache = new Map<string, boolean>();

  private async fileExists(p: string): Promise<boolean> {
    if (ComponentPathResolver.statCache.has(p)) {
      return ComponentPathResolver.statCache.get(p)!;
    }
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(p));
      ComponentPathResolver.statCache.set(p, true);
      return true;
    } catch {
      ComponentPathResolver.statCache.set(p, false);
      return false;
    }
  }

  async resolve(importPath: string, currentPath: string): Promise<string | null> {
    const key = importPath.startsWith('.')
      ? path.resolve(path.dirname(currentPath), importPath)
      : importPath;
    if (ComponentPathResolver.resolveCache.has(key)) {
      return ComponentPathResolver.resolveCache.get(key)!;
    }

    let result: string | null = null;
    try {
      if (importPath.startsWith('.')) {
        const base = path.resolve(path.dirname(currentPath), importPath);
        if (path.extname(base)) {
          if (await this.fileExists(base)) result = base;
        } else {
          const exts = ['.tsx', '.jsx', '.ts', '.js'];
          for (const ext of exts) {
            const candidate = `${base}${ext}`;
            if (await this.fileExists(candidate)) { result = candidate; break; }
          }
          if (!result) {
            for (const ext of exts) {
              const candidate = path.join(base, `index${ext}`);
              if (await this.fileExists(candidate)) { result = candidate; break; }
            }
          }
          if (!result) result = base;
        }
      } else {
        const patterns = [
          `**/${importPath}.{tsx,jsx,ts,js}`,
          `**/${importPath}/index.{tsx,jsx,ts,js}`
        ];
        for (const ptn of patterns) {
          const pKey = `glob:${ptn}`;
          if (ComponentPathResolver.resolveCache.has(pKey)) {
            const cached = ComponentPathResolver.resolveCache.get(pKey)!;
            if (cached) { result = cached; break; }
            continue;
          }
          const matches = await vscode.workspace.findFiles(ptn, null, 1);
          if (matches.length) {
            result = matches[0].fsPath;
            ComponentPathResolver.resolveCache.set(pKey, result);
            break;
          } else {
            ComponentPathResolver.resolveCache.set(pKey, null);
          }
        }
      }
    } catch {
      result = null;
    }
    ComponentPathResolver.resolveCache.set(key, result);
    return result;
  }
}
