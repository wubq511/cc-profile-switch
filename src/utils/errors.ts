export type CcpsErrorOptions = {
  guidance?: string;
  cause?: unknown;
};

export class CcpsError extends Error {
  readonly code: string;
  readonly guidance?: string;

  constructor(code: string, message: string, options: CcpsErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'CcpsError';
    this.code = code;
    this.guidance = options.guidance;
  }
}

export function formatError(error: unknown): string {
  if (error instanceof CcpsError) {
    const firstLine = `${error.code}: ${error.message}`;
    return error.guidance ? `${firstLine}\nNext: ${error.guidance}` : firstLine;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
