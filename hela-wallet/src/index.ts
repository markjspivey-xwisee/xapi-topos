// @foxxi/hela-wallet — public API
export { generateIdentity } from "./identity";
export type { WalletIdentity } from "./identity";
export { WalletSigner, verifyPresentation } from "./credentials";
export type { VerifiableCredential, VerifiablePresentation, PeerVerificationResult } from "./credentials";
export { generateRecommendations } from "./recommendations";
export type { Recommendation } from "./recommendations";
export { HELAClient } from "./hela-client";
export type { HELANodeConfig } from "./hela-client";
export { createWalletApp } from "./app";
export type { WalletConfig } from "./app";
