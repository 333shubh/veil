// Stands in for node:crypto in the browser bundle: the protocol only needs randomBytes outside src/crypto.ts.
import { Buffer } from 'buffer';

export const randomBytes = (length: number): Buffer => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(length)));
