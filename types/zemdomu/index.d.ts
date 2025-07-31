declare module 'zemdomu' {
  export interface LintResult {
    line: number;
    column: number;
    message: string;
    rule: string;
    severity?: 'error' | 'warning' | 'off';
    filePath?: string;
  }
  export interface Rule {
    name: string;
    init?: () => void;
    enterHtml?: (node: any) => LintResult[];
    exitHtml?: (node: any) => LintResult[];
    enterJsx?: (path: any) => LintResult[];
    exitJsx?: (path: any) => LintResult[];
    end?: () => LintResult[];
    test?: (node: any) => boolean;
    message?: string;
  }
  export interface LinterOptions {
    rules?: Record<string, 'error' | 'warning' | 'off'>;
    customRules?: Rule[];
    filePath?: string;
    perf?: any;
  }
  export function lint(content: string, options?: LinterOptions): LintResult[];
  export class ComponentAnalyzer {
    constructor(options: LinterOptions & { crossComponentAnalysis?: boolean; crossComponentDepth?: number }, perf?: any);
    analyzeFile(filePath: string): Promise<any>;
    registerComponent(component: any, issues: LintResult[]): void;
    analyzeComponentTree(): LintResult[];
  }
  export class ComponentPathResolver {
    static setRootDir(dir: string): void;
    static updateDevMode(dev: boolean): void;
    resolve(importPath: string, currentPath: string): Promise<string | null>;
  }
  export class PerformanceDiagnostics {
    record(filePath: string, timings: Record<string, number>): void;
    getAsJSON(): string;
    logSlowest(): void;
  }
}
