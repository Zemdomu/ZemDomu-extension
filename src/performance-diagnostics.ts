import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

export class PerformanceDiagnostics {
  private channel = vscode.window.createOutputChannel('ZemDomu Perf');
  private devMode: boolean;
  private pending = new Map<string, string>();

  constructor(devMode: boolean) {
    this.devMode = devMode;
  }

  updateDevMode(devMode: boolean) {
    this.devMode = devMode;
  }

  record(filePath: string, timings: Record<string, number>) {
    const msg = `${path.basename(filePath)} => ` +
      Object.entries(timings)
        .map(([k, v]) => `${k}:${v.toFixed(2)}ms`)
        .join(' | ');
    this.channel.appendLine(msg);
    if (this.devMode) {
      this.pending.set(filePath, msg);
    }
  }

  applyDiagnostics(uri: vscode.Uri, diags: vscode.Diagnostic[]) {
    if (this.devMode && this.pending.has(uri.fsPath)) {
      const msg = this.pending.get(uri.fsPath)!;
      const diag = new vscode.Diagnostic(
        new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
        msg,
        vscode.DiagnosticSeverity.Information
      );
      diag.source = 'ZemDomu Perf';
      diags.push(diag);
      this.pending.delete(uri.fsPath);
    }
  }

  async reportBundleSize(root: string): Promise<void> {
    const dist = path.join(root, 'dist', 'extension.js');
    const out = path.join(root, 'out', 'extension.js');
    let target = '';
    try {
      await fs.stat(dist);
      target = dist;
    } catch {
      try {
        await fs.stat(out);
        target = out;
      } catch {
        return;
      }
    }
    try {
      const size = (await fs.stat(target)).size;
      const kb = (size / 1024).toFixed(2);
      this.channel.appendLine(`Bundle size (${path.basename(target)}): ${kb} KB`);
    } catch {
      // ignore
    }
  }
}
