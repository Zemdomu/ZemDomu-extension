declare module 'path' {
  export function basename(p: string, ext?: string): string;
  export function extname(p: string): string;
  export function dirname(p: string): string;
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
}
