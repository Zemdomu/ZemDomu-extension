import * as vscode from 'vscode';
import * as path from 'path';

export class ComponentPathResolver {
  private static resolveCache = new Map<string, string | null>();
  private static statCache = new Map<string, boolean>();
  private static aliasCache = new Map<string, Map<string, string>>();
  private static unresolved = new Set<string>();

  private static normalizeKey(p: string): string {
    return p
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .replace(/\.(tsx|ts|jsx|js)$/, '')
      .toLowerCase();
  }

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
    const rawKey = importPath.startsWith('.')
      ? path.resolve(path.dirname(currentPath), importPath)
      : importPath;
    const key = ComponentPathResolver.normalizeKey(rawKey);
    if (ComponentPathResolver.unresolved.has(key)) return null;
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
        const prefix = importPath.split('/')[0];
        let alias = ComponentPathResolver.aliasCache.get(prefix);
        if (!alias) {
          const pattern = `**/${prefix}/**/*.{tsx,jsx,ts,js}`;
          const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 200);
          alias = new Map();
          for (const uri of files) {
            const rel = uri.fsPath.replace(/\\/g, '/');
            const idx = rel.lastIndexOf(`/${prefix}/`);
            if (idx === -1) continue;
            const after = rel.substring(idx + prefix.length + 2).replace(/\.(tsx|ts|jsx|js)$/, '');
            const key1 = ComponentPathResolver.normalizeKey(`${prefix}/${after}`);
            alias.set(key1, uri.fsPath);
            if (after.endsWith('/index')) {
              const trimmed = after.replace(/\/index$/, '');
              alias.set(ComponentPathResolver.normalizeKey(`${prefix}/${trimmed}`), uri.fsPath);
            }
          }
          ComponentPathResolver.aliasCache.set(prefix, alias);
        }

        const normImport = ComponentPathResolver.normalizeKey(importPath);
        result = alias.get(normImport) || null;

        if (!result) {
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
            const matches = await vscode.workspace.findFiles(ptn, '**/node_modules/**', 1);
            if (matches.length) {
              result = matches[0].fsPath;
              ComponentPathResolver.resolveCache.set(pKey, result);
              break;
            } else {
              ComponentPathResolver.resolveCache.set(pKey, null);
            }
          }
        }
      }
    } catch {
      result = null;
    }
    ComponentPathResolver.resolveCache.set(key, result);
    if (result === null) ComponentPathResolver.unresolved.add(key);
    return result;
  }
}
