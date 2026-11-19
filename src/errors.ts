/** An error the CLI prints as its one line and exits with: 1 for a failed read, 2 for a usage error. */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const usage = (message: string) => new CliError(message, 2);
