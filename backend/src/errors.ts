/** Error text safe to return through HTTP/SSE or render in the browser. */
export function publicErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/\b429\b|too many requests|rate limit/i.test(raw)) {
    return "Alchemy is temporarily rate-limiting reads. The request was not executed; please retry in a few seconds.";
  }
  // viem may append the RPC endpoint (including its API key), raw calldata,
  // and a full request body. Those are diagnostics for server logs, never UI.
  return raw
    .replace(/https?:\/\/[^\s'"`]+/g, "[redacted RPC endpoint]")
    .split("\n\nRaw Call Arguments:")[0]
    .split("\nRequest Arguments:")[0];
}
