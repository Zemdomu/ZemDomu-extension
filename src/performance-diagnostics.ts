import type * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

// Optional runtime import so this file can be used without VS Code loaded
let vscodeApi: typeof import('vscode') | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  vscodeApi = require('vscode');
} catch {
  vscodeApi = undefined;
}

export class PerformanceDiagnostics {
  private static latestMetrics = new Map<string, Record<string, number>>();
  private channel: vscode.OutputChannel | null = vscodeApi ? vscodeApi.window.createOutputChannel('ZemDomu Perf') : null;
  private devMode: boolean;
  private pending = new Map<string, string>();

  constructor(devMode: boolean) {
    this.devMode = devMode;
  }

  static getLatestMetrics(): Map<string, Record<string, number>> {
    return this.latestMetrics;
  }

  static resetMetrics(): void {
    this.latestMetrics.clear();
  }

  getAsJSON(): string {
    return JSON.stringify(Object.fromEntries(PerformanceDiagnostics.latestMetrics), null, 2);
  }

  updateDevMode(devMode: boolean) {
    this.devMode = devMode;
  }

  log(msg: string) {
    if (this.devMode && this.channel) {
      this.channel.appendLine(msg);
    }
  }

  record(filePath: string, timings: Record<string, number>) {
    PerformanceDiagnostics.latestMetrics.set(
      filePath,
      JSON.parse(JSON.stringify(timings))
    );

    if (!this.devMode || !this.channel) return;

    const msg = `${path.basename(filePath)} => ` +
      Object.entries(timings)
        .map(([k, v]) => `${k}:${v.toFixed(2)}ms`)
        .join(' | ');
    this.channel.appendLine(msg);
    this.logMemoryUsage();
    this.pending.set(filePath, msg);
  }

  applyDiagnostics(uri: vscode.Uri, diags: vscode.Diagnostic[]) {
    if (this.devMode && this.channel && vscodeApi && this.pending.has(uri.fsPath)) {
      const msg = this.pending.get(uri.fsPath)!;
      const diag = new vscodeApi.Diagnostic(
        new vscodeApi.Range(new vscodeApi.Position(0, 0), new vscodeApi.Position(0, 1)),
        msg,
        vscodeApi.DiagnosticSeverity.Information
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
      if (this.devMode && this.channel) {
        this.channel.appendLine(`Bundle size (${path.basename(target)}): ${kb} KB`);
      }
    } catch {
      // ignore
    }
  }

  private logMemoryUsage() {
    if (this.devMode && this.channel) {
      const mem = process.memoryUsage().rss / 1024 / 1024;
      this.channel.appendLine(`Memory usage: ${mem.toFixed(1)} MB`);
    }
  }
}
