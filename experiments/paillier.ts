// Paillier baseline for E1 and E3: each meter encrypts its reading under the utility's key, the aggregator multiplies
// the ciphertexts, and the utility decrypts the product. Modular exponentiation runs in OpenSSL (BN_mod_exp), reached
// through the Diffie-Hellman API with the composite modulus n^2, so the baseline is not slowed by BigInt arithmetic.
import { createDiffieHellman, generatePrimeSync, randomBytes, type DiffieHellman } from 'node:crypto';

const toBytes = (v: bigint, length: number) => Buffer.from(v.toString(16).padStart(length * 2, '0'), 'hex');
const toBigInt = (b: Uint8Array) => BigInt('0x' + Buffer.from(b).toString('hex'));

function inverse(a: bigint, m: bigint): bigint {
  let [r0, r1, s0, s1] = [((a % m) + m) % m, m, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}

/** x -> x^e mod m in OpenSSL. */
function powmod(e: bigint, m: bigint, length: number): (x: bigint) => bigint {
  const dh: DiffieHellman = createDiffieHellman(toBytes(m, length), Buffer.from([2]));
  dh.setPrivateKey(toBytes(e, length));
  return (x) => toBigInt(dh.computeSecret(toBytes(x, length)));
}

export class Paillier {
  readonly bits: number;
  readonly n: bigint;
  readonly n2: bigint;
  private readonly length: number;
  private readonly mu: bigint;
  private readonly rToN: (x: bigint) => bigint;
  private readonly toLambda: (x: bigint) => bigint;

  constructor(bits: number) {
    const p = generatePrimeSync(bits / 2, { bigint: true });
    const q = generatePrimeSync(bits / 2, { bigint: true });
    const lambda = ((p - 1n) * (q - 1n)) / gcd(p - 1n, q - 1n);
    this.bits = bits;
    this.n = p * q;
    this.n2 = this.n * this.n;
    this.length = Math.ceil(this.n2.toString(16).length / 2);
    this.mu = inverse(lambda, this.n); // with g = n + 1, L(g^lambda mod n^2) = lambda mod n
    this.rToN = powmod(this.n, this.n2, this.length);
    this.toLambda = powmod(lambda, this.n2, this.length);
  }

  /** c = (1 + m n) r^n mod n^2, for a signed reading m. */
  encrypt(m: bigint): bigint {
    const r = (toBigInt(randomBytes(this.length)) % (this.n - 2n)) + 2n;
    return ((1n + ((m % this.n) + this.n) % this.n * this.n) * this.rToN(r)) % this.n2;
  }

  add(a: bigint, b: bigint): bigint {
    return (a * b) % this.n2;
  }

  decrypt(c: bigint): bigint {
    const m = (((this.toLambda(c) - 1n) / this.n) * this.mu) % this.n;
    return m > this.n / 2n ? m - this.n : m;
  }

  /** Ciphertext size on the wire. */
  get ciphertextBytes(): number {
    return this.length;
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}
