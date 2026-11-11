/** Domain errors with stable codes, safe to show to the signed-in user. */
export class DomainError extends Error {
  readonly code: "not_found" | "forbidden" | "conflict" | "invalid";
  constructor(code: DomainError["code"], message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export const notFound = (what: string) => new DomainError("not_found", `${what} not found`);

/** Converts Postgres errors raised by RLS/constraints into DomainErrors; rethrows anything else. */
export function mapDbError(err: unknown, conflictMessage = "That name is already taken"): never {
  const code = (err as { code?: string } | null)?.code;
  if (code === "42501") throw new DomainError("forbidden", "You don't have permission to do that");
  if (code === "23505") throw new DomainError("conflict", conflictMessage);
  if (code === "23514" || code === "22P02") throw new DomainError("invalid", "Some of the values are invalid");
  throw err;
}
