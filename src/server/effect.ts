import type { Context } from "hono";
import * as Effect from "effect/Effect";
import { runEffect } from "../runtime/effect.ts";
import { errorResponse } from "./errors.ts";

export function runHandler<A, T>(c: Context, effect: Effect.Effect<A, unknown, never>, respond: (value: A) => T | Promise<T>): Promise<T> {
  return runEffect(effect)
    .then(respond)
    .catch((e) => {
      const { status, body } = errorResponse(e);
      return c.json(body, status) as T;
    });
}
