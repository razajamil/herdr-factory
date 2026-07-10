// The resident server's OAuth callback relay. Atlassian redirects the browser to the server's https
// listener at /oauth/callback?code=…&state=… (see serve.ts + app.ts); this records the code keyed by
// `state`, and the login initiator (CLI `auth login` / the TUI) polls /oauth/callback-result?state=…
// for it. The server never sees the PKCE verifier or does the exchange — it's a pure code relay, so a
// captured code is useless without the verifier the initiator holds.
//
// In-memory + TTL-pruned: state is short-lived (a login completes in seconds-to-minutes) and the
// initiator polls the SAME server process, so nothing durable is needed.

interface Captured {
  code?: string;
  error?: string;
  at: number; // epoch ms, for TTL pruning
}

const TTL_MS = 10 * 60 * 1000;
const captures = new Map<string, Captured>();

function prune(now: number): void {
  for (const [state, c] of captures) if (now - c.at > TTL_MS) captures.delete(state);
}

/** Record a callback result (the code, or an authorization error) for `state`. */
export function recordCallback(state: string, result: { code?: string; error?: string }): void {
  const now = Date.now();
  prune(now);
  captures.set(state, { ...result, at: now });
}

/** The captured result for `state`, or undefined if the callback hasn't arrived yet. */
export function getCallback(state: string): { code?: string; error?: string } | undefined {
  const c = captures.get(state);
  if (!c) return undefined;
  if (Date.now() - c.at > TTL_MS) {
    captures.delete(state);
    return undefined;
  }
  return { code: c.code, error: c.error };
}

/** Test seam. */
export function resetOAuthCallbacks(): void {
  captures.clear();
}
