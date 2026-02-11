export interface CodeRunner {
  execute(data: string): Promise<unknown>;
}

export function createCodeRunner(code: string): CodeRunner {
  return {
    async execute(data: string): Promise<unknown> {
      const fn = new Function(`return (${code})`)();
      return await fn(data);
    },
  };
}
