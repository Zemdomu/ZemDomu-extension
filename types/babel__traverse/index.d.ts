declare module '@babel/traverse' {
  export type NodePath<T = any> = any;
  export default function traverse(node: any, visitors: any): void;
}
