import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

export function err(c: Context, status: number, message: string) {
  return c.json({ error: message }, status as 400);
}

/** Parse a query param as an integer and clamp it to [min, max]; non-numbers fall back to `dflt`. */
export function clampInt(raw: string | undefined, dflt: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * A request's JSON body as an object. No body reads as {}; anything else that isn't a JSON object
 * (malformed JSON, null, an array, a number) is a 400, so a route never reads fields off null.
 */
export async function body<T = Record<string, unknown>>(c: Context): Promise<T> {
  const text = await c.req.text().catch(() => "");
  if (!text.trim()) return {} as T;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HTTPException(400, { message: "the request body is not valid JSON" });
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HTTPException(400, { message: "the request body must be a JSON object" });
  return v as T;
}

// JSON has types the TypeScript annotation on `body<T>` cannot check, and a value of the wrong one
// is not a smaller version of the right one: `"false"` is truthy, `5` has no `.trim()`, and `{}` is
// not an id. Routes read fields through these, so a bad one is a 400 naming the field rather than a
// coercion that silently does the opposite, or a TypeError from deep inside the store.
//
// Only an absent field (JSON omits it, so `undefined`) counts as not supplied. A `null` is a
// supplied value of the wrong type and is refused, so `{"enabled": null}` cannot read as "leave it
// on" and `{"model": null}` cannot reach `.trim()`.

/** A field that must be a string. */
export function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw new HTTPException(400, { message: `${name} must be a string` });
  return v;
}

/** A field that must be a string when it is supplied; an absent field reads as undefined. */
export function optStr(v: unknown, name: string): string | undefined {
  if (v === undefined) return undefined;
  return str(v, name);
}

/** A field that must be a JSON boolean: `"false"` is a string, not `false`. */
export function bool(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") throw new HTTPException(400, { message: `${name} must be true or false` });
  return v;
}

/** A field that must be a boolean when it is supplied; an absent field reads as undefined. */
export function optBool(v: unknown, name: string): boolean | undefined {
  if (v === undefined) return undefined;
  return bool(v, name);
}

/** A field that must be an array of strings when it is supplied; an absent field reads as undefined. */
export function optStrArray(v: unknown, name: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new HTTPException(400, { message: `${name} must be an array of strings` });
  return v as string[];
}
