// Single source of truth for the running version. Stamped into the server's /health and
// server.json so the supervisor (`ensure-up`) can detect an outdated `serve` and cycle it.
export const VERSION = "0.1.0";
