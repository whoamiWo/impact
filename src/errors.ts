export class ImpactError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = 1) {
    super(message);
    this.name = "ImpactError";
    this.exitCode = exitCode;
  }
}

export class UsageError extends ImpactError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}

export class ConfigError extends ImpactError {
  constructor(message: string) {
    super(message, 2);
    this.name = "ConfigError";
  }
}
