import * as path from 'path';
import * as vscode from 'vscode';

export class IssueTracker implements vscode.Disposable {
  private readonly issueCounts = new Map<string, number>();
  private scanning = false;
  private scanPhase: string | undefined;

  constructor(private readonly statusBar: vscode.StatusBarItem) {
    this.statusBar.name = 'ZemDomu Issues';
    this.statusBar.command = 'zemdomu.lintWorkspace';
    this.statusBar.text = 'ZemDomu: ready';
    this.statusBar.tooltip = 'ZemDomu semantic linter is standing by.';
    this.setAccessibility(
      'ZemDomu semantic linter ready. Activate to scan the workspace.'
    );
    this.statusBar.show();
  }

  beginScan(message?: string): void {
    this.scanning = true;
    this.scanPhase = message ?? 'Discovering supported workspace files.';
    this.renderScanning();
  }

  updateScanPhase(message: string): void {
    if (!this.scanning) return;
    this.scanPhase = message;
    this.renderScanning();
  }

  finishScan(): void {
    this.scanning = false;
    this.scanPhase = undefined;
    this.refresh(true);
  }

  supersedeScan(): void {
    this.scanning = false;
    this.scanPhase = undefined;
    const total = this.getTotalCount();
    this.statusBar.text = total > 0
      ? `ZemDomu: ${total} ${total === 1 ? 'issue' : 'issues'}`
      : 'ZemDomu: all clear';
    this.statusBar.tooltip = [
      'The workspace scan was superseded by newer lint results.',
      this.buildTooltip(total),
    ].join('\n');
    this.setAccessibility(
      total > 0
        ? `ZemDomu workspace scan superseded by newer lint results. ${total} ${total === 1 ? 'issue' : 'issues'} currently reported. Activate to scan the workspace.`
        : 'ZemDomu workspace scan superseded by newer lint results. No issues currently reported. Activate to scan the workspace.'
    );
    this.statusBar.show();
  }

  failScan(message: string): void {
    this.scanning = false;
    this.scanPhase = undefined;
    this.statusBar.text = 'ZemDomu: scan failed';
    this.statusBar.tooltip = message;
    this.setAccessibility(`ZemDomu workspace scan failed. ${message}`);
    this.statusBar.show();
  }

  clear(): void {
    this.issueCounts.clear();
    if (!this.scanning) {
      this.refresh();
    } else {
      this.renderScanning();
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
      this.renderScanning();
    } else {
      this.refresh();
    }
  }

  private renderScanning(): void {
    const total = this.getTotalCount();
    const suffix = total > 0 ? ` (${total})` : '';
    const phase = this.scanPhase ?? 'Scanning workspace for ZemDomu issues.';
    this.statusBar.text = `ZemDomu: scanning...${suffix}`;
    this.statusBar.tooltip = total > 0
      ? `${phase}\n${this.buildTooltip(total)}`
      : phase;
    const findingStatus = total > 0
      ? ` ${total} ${total === 1 ? 'issue is' : 'issues are'} currently detected.`
      : '';
    this.setAccessibility(`ZemDomu scan in progress. ${phase}${findingStatus}`);
    this.statusBar.show();
  }

  private refresh(workspaceScanCompleted = false): void {
    const total = this.getTotalCount();
    if (total > 0) {
      const label = total === 1 ? 'issue' : 'issues';
      this.statusBar.text = `ZemDomu: ${total} ${label}`;
    } else {
      this.statusBar.text = 'ZemDomu: all clear';
    }
    this.statusBar.tooltip = this.buildTooltip(total);
    const prefix = workspaceScanCompleted
      ? 'ZemDomu workspace scan complete.'
      : 'ZemDomu diagnostics updated.';
    this.setAccessibility(total > 0
      ? `${prefix} ${total} ${total === 1 ? 'issue' : 'issues'} found. Activate to scan the workspace.`
      : `${prefix} No issues currently reported. Activate to scan the workspace.`
    );
    this.statusBar.show();
  }

  private setAccessibility(label: string): void {
    this.statusBar.accessibilityInformation = { label, role: 'button' };
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
