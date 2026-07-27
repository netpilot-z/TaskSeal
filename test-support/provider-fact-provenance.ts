import type {
  ProviderFactProvenanceVerifier
} from "../src/application/provider-fact-provenance.ts";

export function createTrustedTestProvenanceVerifier():
  ProviderFactProvenanceVerifier {
  return {
    async verify(claims) {
      return claims.map((claim) => ({
        schemaVersion: 1,
        claimDigest: claim.claimDigest,
        outcome: "verified"
      }));
    }
  };
}
