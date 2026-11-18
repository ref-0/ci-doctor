// A token's digest, shared by the Worker and scripts/credential.ts. Reference implementation from
// a production monorepo; adapt to your repo. The Worker deploys on its own and imports no
// workspace package, so its deploy trigger paths stay this folder alone.
/** A token's SHA-256, in lowercase hex: all the Worker knows of a credential's token. */
export const tokenDigest = async (token: string) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
  );

  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};
