declare module 'zemdomu' {
  export interface LintResult {
    line: number;
    column: number;
    message: string;
    rule: string;
  }

  export interface Rule {
    name: string;
    init?: () => void;
    enterHtml?: (node: any) => LintResult[];
    exitHtml?: (node: any) => LintResult[];
    enterJsx?: (path: any) => LintResult[];
    exitJsx?: (path: any) => LintResult[];
    end?: () => LintResult[];
  }

  export interface LinterOptions {
    rules?: Record<string, boolean>;
    customRules?: Rule[];
  }

  export function lint(content: string, options?: LinterOptions): LintResult[];
}
