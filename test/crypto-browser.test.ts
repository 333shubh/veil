// The browser backend must agree with the Node backend byte for byte, so the demo runs the same protocol.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as browser from '../src/crypto.browser.ts';
import * as node from '../src/crypto.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('browser crypto backend', () => {
  it('matches the Node backend on the PRG, keystream, HKDF, HMAC and SHA-256', () => {
    const key = randomBytes(32);
    const info = randomBytes(40);
    expect(browser.prg(key, 7, 2 ** 33 + 5)).toBe(node.prg(key, 7, 2 ** 33 + 5));
    expect(hex(browser.keystream(key, 1, 2, 100))).toBe(hex(node.keystream(key, 1, 2, 100)));
    expect(hex(browser.hkdf(key, info))).toBe(hex(node.hkdf(key, info)));
    expect(hex(browser.tag(key, info))).toBe(hex(node.tag(key, info)));
    expect(hex(browser.sha256(key, info))).toBe(hex(node.sha256(key, info)));
    const [a, b] = [browser.u32Stream(key), node.u32Stream(key)];
    for (let i = 0; i < 3000; i++) expect(a()).toBe(b());
  });

  it('interoperates on X25519, AEAD and Ed25519', () => {
    const [nb, bb] = [node.x25519Keygen(), browser.x25519Keygen()];
    expect(hex(node.x25519(nb, bb.pk))).toBe(hex(browser.x25519(bb, nb.pk)));
    const [key, nonce, aad, msg] = [randomBytes(32), randomBytes(12), randomBytes(5), randomBytes(33)];
    expect(hex(browser.seal(key, nonce, aad, msg))).toBe(hex(node.seal(key, nonce, aad, msg)));
    expect(hex(browser.open(key, nonce, aad, node.seal(key, nonce, aad, msg)))).toBe(hex(msg));
    const [ns, bs] = [node.ed25519Keygen(), browser.ed25519Keygen()];
    expect(browser.verifyBytes(ns.publicKey, msg, node.signBytes(ns, msg))).toBe(true);
    expect(node.verifyBytes(bs.publicKey, msg, browser.signBytes(bs, msg))).toBe(true);
    expect(browser.verifyBytes(ns.publicKey, randomBytes(33), node.signBytes(ns, msg))).toBe(false);
  });
});
