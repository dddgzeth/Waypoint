/**
 * Builds the exact EIP-4361 message string the frontend also constructs
 * (duplicated in plain JS there, since app.html has no build step / bundler
 * to share this module with the browser). Kept here as the single source of
 * truth to diff the frontend's copy against in tests.
 */
export function buildSiweMessage(params: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}): string {
  const { domain, address, statement, uri, chainId, nonce, issuedAt } = params;
  return `${domain} wants you to sign in with your Ethereum account:
${address}

${statement}

URI: ${uri}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${issuedAt}`;
}
