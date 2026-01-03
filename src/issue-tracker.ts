import * as path from 'path';
import * as vscode from 'vscode';

export class IssueTracker implements vscode.Disposable {
  private readonly issueCounts = new Map<string, number>();
  private scanning = false;

  constructor(private readonly statusBar: vscode.StatusBarItem) {
    this.statusBar.name = 'ZemDomu Issues';
    this.statusBar.command = 'zemdomu.lintWorkspace';
    this.statusBar.text = 'ZemDomu: ready';
    this.statusBar.tooltip = 'ZemDomu semantic linter is standing by.';
    this.statusBar.show();
  }

  beginScan(message?: string): void {
    this.scanning = true;
    this.statusBar.text = 'ZemDomu: scanning...';
    this.statusBar.tooltip = message ?? 'Scanning workspace for ZemDomu issues...';
    this.statusBar.show();
  }

  finishScan(): void {
    this.scanning = false;
    this.refresh();
  }

  clear(): void {
    this.issueCounts.clear();
    if (!this.scanning) {
      this.refresh();
    } else {
      this.statusBar.text = 'ZemDomu: scanning...';
      this.statusBar.tooltip = 'Scanning workspace for ZemDomu issues...';
      this.statusBar.show();
    }
  }

  updateFile(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]): void {
    const count = diagnostics.length;
    const key = uri.fsPath;
    if (count > 0) {
      this.issueCounts.set(key, count);
    } else {
      this.issueCounts.delete(key);
    }
    this.reportProgress();
  }

  removeFile(uri: vscode.Uri): void {
    this.issueCounts.delete(uri.fsPath);
    this.reportProgress();
  }

  getTotalCount(): number {
    let total = 0;
    for (const count of this.issueCounts.values()) {
      total += count;
    }
    return total;
  }

  dispose(): void {
    this.statusBar.dispose();
  }

  private reportProgress(): void {
    if (this.scanning) {
      const total = this.getTotalCount();
      const suffix = total > 0 ? ` (${total})` : '';
      this.statusBar.text = `ZemDomu: scanning...${suffix}`;
      this.statusBar.tooltip = this.buildTooltip(total);
      this.statusBar.show();
    } else {
      this.refresh();
    }
  }

  private refresh(): void {
    const total = this.getTotalCount();
    if (total > 0) {
      const label = total === 1 ? 'issue' : 'issues';
      this.statusBar.text = `ZemDomu: ${total} ${label}`;
    } else {
      this.statusBar.text = 'ZemDomu: all clear';
    }
    this.statusBar.tooltip = this.buildTooltip(total);
    this.statusBar.show();
  }

  private buildTooltip(total: number): string {
    if (total === 0) {
      return 'No ZemDomu issues in this workspace.';
    }
    const details = [...this.issueCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([file, count]) => `${path.basename(file)}: ${count}`);
    const header = `ZemDomu found ${total} ${total === 1 ? 'issue' : 'issues'} in this workspace.`;
    if (details.length === 0) {
      return header;
    }
    return `${header}\n${details.join('\n')}`;
  }
}
