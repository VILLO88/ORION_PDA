/**
 * A ZIM reader in plain TypeScript, enough for the Wikipedia converter.
 *
 * Why not libzim: its Node binding is a native module, to rebuild for every
 * Electron version and every OS. The format is simple (openZIM spec,
 * https://wiki.openzim.org/wiki/ZIM_file_format): a header, a MIME list,
 * pointer lists, directory entries and clusters. Clusters are zstd today
 * (fzstd, plain JS); old ZIMs in xz are refused with a message.
 *
 * Reads with positioned reads (fs.readSync), never the whole file: a
 * Wikipedia ZIM is several GB.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { decompress } from "fzstd";

export interface Dirent {
  index: number;
  mime: number; // index in mimes, or REDIRECT
  ns: string;
  path: string;
  /** The title, or the path when the entry has none (libzim does the same). */
  title: string;
  redirect: number; // redirects: target entry index
  cluster: number;
  blob: number;
}

export const REDIRECT = 0xffff;
const LINKTARGET = 0xfffe;
const DELETED = 0xfffd;

export class Zim {
  private fd: number;
  readonly entryCount: number;
  readonly clusterCount: number;
  readonly mainPage: number;
  readonly minor: number;
  readonly mimes: string[] = [];
  private pathPtr: Buffer;
  private clusterPtr: Buffer;
  private checksumPos: number;
  // a window over the directory entries, which are read one by one
  private win: Buffer = Buffer.alloc(0);
  private winPos = -1;
  // the last cluster, decompressed: articles are read in cluster order
  private lastCluster = -1;
  private lastBlobs: Buffer[] = [];

  constructor(path: string) {
    this.fd = openSync(path, "r");
    const h = this.read(0, 80);
    if (h.readUInt32LE(0) !== 0x044d495a) throw new Error("not a ZIM file");
    this.minor = h.readUInt16LE(6);
    this.entryCount = h.readUInt32LE(24);
    this.clusterCount = h.readUInt32LE(28);
    const pathPtrPos = Number(h.readBigUInt64LE(32));
    const clusterPtrPos = Number(h.readBigUInt64LE(48));
    const mimeListPos = Number(h.readBigUInt64LE(56));
    this.mainPage = h.readUInt32LE(64);
    this.checksumPos = Number(h.readBigUInt64LE(72));

    const ml = this.read(mimeListPos, 4096);
    let p = 0;
    for (;;) {
      const e = ml.indexOf(0, p);
      if (e <= p) break;
      this.mimes.push(ml.toString("utf8", p, e));
      p = e + 1;
    }
    this.pathPtr = this.read(pathPtrPos, this.entryCount * 8);
    this.clusterPtr = this.read(clusterPtrPos, this.clusterCount * 8);
  }

  close(): void {
    closeSync(this.fd);
  }

  read(pos: number, len: number): Buffer {
    const b = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(this.fd, b, got, len - got, pos + got);
      if (n <= 0) break;
      got += n;
    }
    return got === len ? b : b.subarray(0, got);
  }

  private bytes(pos: number, len: number): Buffer {
    if (this.winPos < 0 || pos < this.winPos || pos + len > this.winPos + this.win.length) {
      this.win = this.read(pos, Math.max(len, 1 << 16));
      this.winPos = pos;
    }
    return this.win.subarray(pos - this.winPos, pos - this.winPos + len);
  }

  dirent(index: number): Dirent {
    const pos = Number(this.pathPtr.readBigUInt64LE(index * 8));
    let b = this.bytes(pos, 1024);
    const mime = b.readUInt16LE(0);
    const ns = String.fromCharCode(b[3]);
    const fixed = mime === REDIRECT ? 12 : mime === LINKTARGET || mime === DELETED ? 8 : 16;
    let e1 = b.indexOf(0, fixed);
    let e2 = e1 >= 0 ? b.indexOf(0, e1 + 1) : -1;
    if (e2 < 0) {
      b = this.bytes(pos, 8192); // a very long path or title
      e1 = b.indexOf(0, fixed);
      e2 = b.indexOf(0, e1 + 1);
    }
    const path = b.toString("utf8", fixed, e1);
    const title = b.toString("utf8", e1 + 1, e2);
    return {
      index,
      mime,
      ns,
      path,
      title: title.length ? title : path,
      redirect: mime === REDIRECT ? b.readUInt32LE(8) : -1,
      cluster: fixed === 16 ? b.readUInt32LE(8) : -1,
      blob: fixed === 16 ? b.readUInt32LE(12) : -1,
    };
  }

  /** The entries of one namespace: [first, end) in path order. Pointers
   *  are sorted by namespace then path, so two binary searches. */
  namespaceRange(ns: string): [number, number] {
    const first = (target: string): number => {
      let lo = 0;
      let hi = this.entryCount;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.dirent(mid).ns < target) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    return [first(ns), first(String.fromCharCode(ns.charCodeAt(0) + 1))];
  }

  /** The articles' namespace: C since ZIM 6.1, A before. */
  articleNs(): string {
    return this.minor >= 1 ? "C" : "A";
  }

  findPath(ns: string, path: string): Dirent | null {
    let [lo, hi] = this.namespaceRange(ns);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const d = this.dirent(mid);
      if (d.path === path) return d;
      if (d.path < path) lo = mid + 1;
      else hi = mid;
    }
    return null;
  }

  metadata(name: string): string {
    const d = this.findPath("M", name);
    return d && d.mime !== REDIRECT ? this.blob(d.cluster, d.blob).toString("utf8") : "";
  }

  /** Follows redirects; null after 5 hops or on a broken chain. */
  resolve(d: Dirent): Dirent | null {
    let cur = d;
    for (let i = 0; i < 6 && cur.mime === REDIRECT; i++) {
      if (cur.redirect < 0 || cur.redirect >= this.entryCount) return null;
      cur = this.dirent(cur.redirect);
    }
    return cur.mime === REDIRECT ? null : cur;
  }

  blob(cluster: number, blob: number): Buffer {
    if (cluster !== this.lastCluster) {
      this.lastBlobs = this.readCluster(cluster);
      this.lastCluster = cluster;
    }
    return this.lastBlobs[blob] ?? Buffer.alloc(0);
  }

  private readCluster(n: number): Buffer[] {
    const start = Number(this.clusterPtr.readBigUInt64LE(n * 8));
    const end = n + 1 < this.clusterCount ? Number(this.clusterPtr.readBigUInt64LE((n + 1) * 8)) : this.checksumPos;
    const raw = this.read(start, end - start);
    const info = raw[0];
    const comp = info & 0x0f;
    const wide = (info & 0x10) !== 0;
    let data: Buffer;
    if (comp === 0 || comp === 1) data = raw.subarray(1);
    else if (comp === 5) data = Buffer.from(decompress(raw.subarray(1)));
    else throw new Error("this ZIM uses xz compression: download a newer one (zstd) from Kiwix");
    const off = (i: number): number => (wide ? Number(data.readBigUInt64LE(i * 8)) : data.readUInt32LE(i * 4));
    const count = off(0) / (wide ? 8 : 4) - 1;
    const blobs: Buffer[] = [];
    for (let i = 0; i < count; i++) blobs.push(data.subarray(off(i), off(i + 1)));
    return blobs;
  }
}
