declare module '@babel/types' {
  export type JSXElement = any;
  export type JSXAttribute = any;
  export function isJSXIdentifier(node: any): boolean;
  export function isJSXAttribute(node: any): boolean;
  export function isJSXElement(node: any): boolean;
  export function isStringLiteral(node: any): boolean;
  export function isImportSpecifier(node: any): boolean;
  export function isImportDefaultSpecifier(node: any): boolean;
}
