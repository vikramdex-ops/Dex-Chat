// The signing and hashing the browser apps need where WebCrypto lacks them (Ed25519 arrived in
// Safari only with iOS 17): re-exported here so apps without their own copy use core's.
export { ed25519 } from '@noble/curves/ed25519.js';
export { sha256 } from '@noble/hashes/sha2.js';
