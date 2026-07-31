/**
 * Minimal ambient declaration for the single `node:crypto` API the verifier
 * uses (`createHash('sha256')`). Declared here so the SDK keeps `typescript` as
 * its ONLY devDependency — no `@types/node`, zero runtime dependencies.
 *
 * At runtime `digest()` returns a Node `Buffer`, which is a `Uint8Array`
 * subclass; typing it as `Uint8Array` is accurate and avoids needing Buffer.
 */
declare module 'node:crypto' {
  export interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(): Uint8Array;
  }
  export function createHash(algorithm: string): Hash;
}
