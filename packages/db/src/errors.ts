export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MigrationConfigError extends MigrationError {}
export class MigrationDiscoveryError extends MigrationError {}
export class MigrationValidationError extends MigrationError {}
export class MigrationLockError extends MigrationError {}
export class MigrationExecutionError extends MigrationError {}
export class SeedError extends MigrationError {}
