declare module 'htmlparser2' {
  export class Parser {
    constructor(handler: any, options?: any);
    write(chunk: string): void;
    end(): void;
  }
}
