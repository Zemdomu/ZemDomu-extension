declare module '@babel/traverse' {
  export type NodePath = any;
  export default function traverse(node: any, visitors: any): void;
}
