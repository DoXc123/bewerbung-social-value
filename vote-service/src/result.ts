// A value that is either a success or a failure with a reason. The caller
// must look at `ok` before it can touch `value`, so a failure can't be
// forgotten (TypeScript refuses to compile it).
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
