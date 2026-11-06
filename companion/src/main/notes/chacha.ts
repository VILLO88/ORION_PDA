/**
 * ChaCha20-Poly1305 (RFC 8439), scritto qui.
 *
 * ⚠️ **Perché non `node:crypto`.** In Node il cifrario c'è; **in Electron
 * no**. Electron usa BoringSSL al posto di OpenSSL, e lì
 * `createCipheriv("chacha20-poly1305")` risponde `Unknown cipher` — mentre
 * scrypt c'è. Il 9 ottobre 2026 la prima versione delle note protette
 * funzionava in ogni prova fatta con Node e non apriva niente dentro l'app:
 * l'errore veniva preso per "password sbagliata", e il dialogo si chiudeva
 * senza una parola.
 *
 * La lezione è la stessa del Bluetooth: una cosa provata con `node` non è
 * provata in Electron. Questo file si prova nei due modi — contro
 * `node:crypto` dove c'è, e fatto girare dall'eseguibile di Electron.
 *
 * È la traduzione di `cripto.c` del firmware, che a sua volta è provato
 * contro Node. Poly1305 qui usa BigInt: una nota è al più qualche kilobyte,
 * e la chiarezza vale più dei microsecondi.
 */

import { timingSafeEqual } from "node:crypto";

/** Il sigillo non torna: testo o intestazione alterati, o chiave sbagliata. */
export class TagError extends Error {
  constructor() {
    super("ChaCha20-Poly1305: authentication failed");
    this.name = "TagError";
  }
}

const rotl = (v: number, n: number): number => ((v << n) | (v >>> (32 - n))) >>> 0;

function quarto(x: Uint32Array, a: number, b: number, c: number, d: number): void {
  x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 16);
  x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 12);
  x[a] = (x[a] + x[b]) >>> 0; x[d] = rotl(x[d] ^ x[a], 8);
  x[c] = (x[c] + x[d]) >>> 0; x[b] = rotl(x[b] ^ x[c], 7);
}

function stato(chiave: Buffer, nonce: Buffer, contatore: number): Uint32Array {
  const s = new Uint32Array(16);
  s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = chiave.readUInt32LE(4 * i);
  s[12] = contatore >>> 0;
  for (let i = 0; i < 3; i++) s[13 + i] = nonce.readUInt32LE(4 * i);
  return s;
}

function blocco(s: Uint32Array): Buffer {
  const x = new Uint32Array(s);
  for (let i = 0; i < 10; i++) {
    quarto(x, 0, 4, 8, 12); quarto(x, 1, 5, 9, 13);
    quarto(x, 2, 6, 10, 14); quarto(x, 3, 7, 11, 15);
    quarto(x, 0, 5, 10, 15); quarto(x, 1, 6, 11, 12);
    quarto(x, 2, 7, 8, 13); quarto(x, 3, 4, 9, 14);
  }
  const out = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) out.writeUInt32LE((x[i] + s[i]) >>> 0, 4 * i);
  return out;
}

/** XOR del flusso di chiave, dal blocco `contatore` in poi. */
function chachaXor(chiave: Buffer, nonce: Buffer, contatore: number, dati: Buffer): Buffer {
  const s = stato(chiave, nonce, contatore);
  const out = Buffer.alloc(dati.length);
  for (let off = 0; off < dati.length; off += 64) {
    const ks = blocco(s);
    s[12] = (s[12] + 1) >>> 0;
    const n = Math.min(64, dati.length - off);
    for (let i = 0; i < n; i++) out[off + i] = dati[off + i] ^ ks[i];
  }
  return out;
}

const P1305 = (1n << 130n) - 5n;

function leBig(b: Buffer): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}

function poly1305(chiave: Buffer, msg: Buffer): Buffer {
  const r = leBig(chiave.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leBig(chiave.subarray(16, 32));
  let h = 0n;
  for (let off = 0; off < msg.length; off += 16) {
    const pezzo = msg.subarray(off, Math.min(off + 16, msg.length));
    h = ((h + leBig(pezzo) + (1n << BigInt(8 * pezzo.length))) * r) % P1305;
  }
  let t = (h + s) & ((1n << 128n) - 1n);
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) { out[i] = Number(t & 0xffn); t >>= 8n; }
  return out;
}

function sigillo(chiave: Buffer, nonce: Buffer, aad: Buffer, ct: Buffer): Buffer {
  // La chiave di Poly1305 è la prima metà del blocco 0 del flusso.
  const k = blocco(stato(chiave, nonce, 0)).subarray(0, 32);
  const pad = (n: number): Buffer => Buffer.alloc((16 - (n % 16)) % 16);
  const lun = Buffer.alloc(16);
  lun.writeBigUInt64LE(BigInt(aad.length), 0);
  lun.writeBigUInt64LE(BigInt(ct.length), 8);
  const tag = poly1305(k, Buffer.concat([aad, pad(aad.length), ct, pad(ct.length), lun]));
  k.fill(0);
  return tag;
}

function controlla(chiave: Buffer, nonce: Buffer): void {
  if (chiave.length !== 32) throw new Error("ChaCha20-Poly1305: la chiave è di 32 byte");
  if (nonce.length !== 12) throw new Error("ChaCha20-Poly1305: il nonce è di 12 byte");
}

export function aeadSeal(
  chiave: Buffer,
  nonce: Buffer,
  aad: Buffer,
  testo: Buffer,
): { ct: Buffer; tag: Buffer } {
  controlla(chiave, nonce);
  const ct = chachaXor(chiave, nonce, 1, testo);
  return { ct, tag: sigillo(chiave, nonce, aad, ct) };
}

/** Il testo, o `TagError`. Il sigillo si controlla PRIMA di decifrare: non
 *  esce mai, nemmeno per un attimo, del testo che nessuno ha garantito. */
export function aeadOpen(
  chiave: Buffer,
  nonce: Buffer,
  aad: Buffer,
  ct: Buffer,
  tag: Buffer,
): Buffer {
  controlla(chiave, nonce);
  if (tag.length !== 16 || !timingSafeEqual(sigillo(chiave, nonce, aad, ct), tag)) {
    throw new TagError();
  }
  return chachaXor(chiave, nonce, 1, ct);
}
