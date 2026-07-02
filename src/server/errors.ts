import * as Data from "effect/Data";

export class RepoNotConfigured extends Data.TaggedError("RepoNotConfigured")<{
  readonly repo: string;
  readonly knownRepos: readonly string[];
}> {}

export class ServerFailure extends Data.TaggedError("ServerFailure")<{
  readonly cause: unknown;
}> {}

export type ServerError = RepoNotConfigured | ServerFailure;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function errorResponse(e: unknown): { status: 404 | 500; body: { error: string } } {
  if (e instanceof RepoNotConfigured) {
    return {
      status: 404,
      body: { error: `repo "${e.repo}" not configured (server knows: ${e.knownRepos.join(", ") || "none"})` },
    };
  }
  if (e instanceof ServerFailure) return { status: 500, body: { error: errorMessage(e.cause) } };
  return { status: 500, body: { error: errorMessage(e) } };
}
