/**
 * Le note senza cavo: lo specchio di `/NOTE` e i suoi due versi.
 *
 * Il perché sta in `main/ipc/bleLocal.ts`. In breve: la pagina delle note
 * lavora su una cartella; senza cavo quella cartella è una copia locale
 * tenuta allineata al dispositivo da qui.
 *
 *   `bleNoteAllinea()`  manda prima ciò che nello specchio è rimasto da
 *                       mandare, poi rilegge il dispositivo. Da chiamare alla
 *                       connessione e a ogni "Reload".
 *   `bleNoteSpingi()`   riporta sul dispositivo ciò che è cambiato nello
 *                       specchio. Da chiamare dopo ogni modifica.
 *
 * ⚠️ **Prima si spinge, poi si tira, mai il contrario.** Un sync con
 * Obsidian scrive nello specchio e segna quelle note come "già sul
 * dispositivo". Se la radio cade prima che ci arrivino, e alla connessione
 * dopo lo specchio venisse semplicemente rifatto dal dispositivo, quelle
 * note sparirebbero — e il sync successivo, non trovandole, le cancellerebbe
 * anche da Obsidian. Spingendo per primo ciò che era rimasto indietro, no.
 *
 * ⚠️ Costa: leggere dal dispositivo va a qualche centinaio di byte al
 * secondo. Per questo si rilegge solo ciò che è cambiato — dimensione e data
 * dalla directory, e nel dubbio il CRC che il dispositivo calcola da sé.
 */

import type { BleMirrorState, BleSnapshot } from "@shared/ipc-types";
import { api } from "./api";
import { bleCondiviso, crc32, type VoceBle } from "./bleOrion";

const RADICE = "/NOTE";
/* Il deposito delle note protette (firmware fino al 10/10/2026) e la sua
   sigla (da lì in poi, quando il deposito sta nella flash di ORION): i due
   file col punto che lo specchio deve avere. Vedi main/notes/vault.ts. */
const DEPOSITO = [".orion_vault", ".orion_vault_id"];

type Dice = (s: string) => void;

function eNota(nome: string): boolean {
  const n = nome.toLowerCase();
  return n.endsWith(".txt") || n.endsWith(".enc");
}

/** Lo specchio è valido solo dopo un allineamento riuscito in questa
 *  sessione: prima, spingere vorrebbe dire fidarsi di una fotografia di
 *  chissà quando. */
let allineato = false;

/* Caduta la radio, lo specchio non e' piu' garantito: alla prossima
   connessione il dispositivo puo' essere cambiato, o essere un altro. */
bleCondiviso.suCambio(() => {
  if (!bleCondiviso.connesso) allineato = false;
});

export function bleNoteAllineato(): boolean {
  return allineato && bleCondiviso.connesso;
}

/** Tutta `/NOTE` sul dispositivo: file (solo le note) e cartelle. */
async function leggiAlbero(
  dice: Dice,
): Promise<{ files: Map<string, VoceBle>; dirs: string[] }> {
  const files = new Map<string, VoceBle>();
  const dirs: string[] = [];
  const visita = async (rel: string): Promise<void> => {
    dice(`Reading ${rel || "NOTE"}…`);
    let voci: VoceBle[];
    try {
      voci = await bleCondiviso.ls(rel ? `${RADICE}/${rel}` : RADICE);
    } catch (e) {
      /* Una scheda nuova non ha ancora `/NOTE`: è una cartella vuota. */
      if (rel === "" && /cartella/.test(String(e))) return;
      throw e;
    }
    for (const v of voci) {
      const r = rel ? `${rel}/${v.nome}` : v.nome;
      if (v.cartella) {
        dirs.push(r);
        await visita(r);
      } else if (eNota(v.nome)) {
        files.set(r, v);
      }
    }
  };
  await visita("");
  return { files, dirs };
}

/** Ciò che nello specchio differisce dalla fotografia: da mandare o togliere. */
function differenze(st: BleMirrorState): {
  manda: string[];
  togli: string[];
  creaDir: string[];
  togliDir: string[];
} {
  const foto: BleSnapshot = st.snapshot ?? { files: {}, dirs: [] };
  const locali = new Map(st.files.map((f) => [f.rel, f]));
  const manda: string[] = [];
  const togli: string[] = [];
  for (const f of st.files) {
    /* Il deposito lo crea e lo cambia solo il dispositivo: mai mandato. */
    if (DEPOSITO.includes(f.rel)) continue;
    const s = foto.files[f.rel];
    if (!s || s.crc !== f.crc || s.size !== f.size) manda.push(f.rel);
  }
  for (const rel of Object.keys(foto.files)) {
    if (!DEPOSITO.includes(rel) && !locali.has(rel)) togli.push(rel);
  }
  const creaDir = st.dirs.filter((d) => !foto.dirs.includes(d));
  /* Le più profonde per prime: una cartella si toglie solo da vuota. */
  const togliDir = foto.dirs
    .filter((d) => !st.dirs.includes(d))
    .sort((a, b) => b.length - a.length);
  return { manda, togli, creaDir, togliDir };
}

/**
 * Riporta sul dispositivo le modifiche fatte nello specchio. Ritorna quante
 * operazioni ha fatto. Se una fallisce, la fotografia registra quelle
 * riuscite e l'errore esce: il resto si riprova al prossimo giro.
 */
export async function bleNoteSpingi(dice: Dice = () => undefined): Promise<number> {
  if (!bleNoteAllineato()) return 0;
  const st = await api.ble.mirrorState();
  const d = differenze(st);
  const quante = d.manda.length + d.togli.length + d.creaDir.length + d.togliDir.length;
  if (quante === 0) return 0;

  const foto: BleSnapshot = st.snapshot ?? { files: {}, dirs: [] };
  const locali = new Map(st.files.map((f) => [f.rel, f]));
  try {
    for (const dir of d.creaDir.sort((a, b) => a.length - b.length)) {
      await bleCondiviso.creaCartella(`${RADICE}/${dir}`).catch((e) => {
        if (!/esiste/.test(String(e))) throw e;
      });
      foto.dirs.push(dir);
    }
    for (const rel of d.manda) {
      const dati = await api.ble.mirrorRead({ rel });
      await bleCondiviso.inviaFile(`${RADICE}/${rel}`, dati, (p) => {
        if (p.inviati !== undefined && p.totali) {
          dice(`Sending ${rel}… ${Math.round((p.inviati / p.totali) * 100)}%`);
        }
      });
      const l = locali.get(rel)!;
      /* La data nuova non la sappiamo: vuota, e al prossimo allineamento
         sarà il CRC a dire che è lo stesso file. */
      foto.files[rel] = { size: l.size, crc: l.crc, ts: "" };
    }
    for (const rel of d.togli) {
      dice(`Deleting ${rel}…`);
      await bleCondiviso.cancella(`${RADICE}/${rel}`).catch((e) => {
        if (!/non c'e'/.test(String(e))) throw e;
      });
      delete foto.files[rel];
    }
    for (const dir of d.togliDir) {
      await bleCondiviso.cancella(`${RADICE}/${dir}`).catch(() => undefined);
      foto.dirs = foto.dirs.filter((x) => x !== dir);
    }
  } finally {
    await api.ble.mirrorSaveSnapshot(foto);
  }
  return quante;
}

/**
 * Allinea lo specchio al dispositivo e ritorna la sua radice, da usare come
 * `mountPath`. Si connette se serve.
 */
export async function bleNoteAllinea(dice: Dice = () => undefined): Promise<string> {
  if (!bleCondiviso.connesso) {
    dice("Connecting…");
    await bleCondiviso.connetti();
  }
  if (!bleCondiviso.naviga) {
    throw new Error(
      "The firmware on this ORION is too old to read notes over Bluetooth: update it.",
    );
  }

  /* 1. Prima ciò che era rimasto da mandare. Solo se una fotografia c'è:
        senza, non si sa cosa sia "nuovo qui" e cosa "sparito di là". */
  let st = await api.ble.mirrorState();
  if (st.snapshot) {
    allineato = true;
    try {
      const n = await bleNoteSpingi(dice);
      if (n > 0) st = await api.ble.mirrorState();
    } catch (e) {
      allineato = false;
      throw e;
    }
  }
  allineato = false;

  /* 2. Poi il dispositivo com'è adesso. */
  const { files, dirs } = await leggiAlbero(dice);
  const locali = new Map(st.files.map((f) => [f.rel, f]));
  const vecchia = st.snapshot?.files ?? {};
  const foto: BleSnapshot = { files: {}, dirs };

  for (const dir of dirs) await api.ble.mirrorMkdir({ rel: dir });

  let n = 0;
  for (const [rel, v] of files) {
    n++;
    const loc = locali.get(rel);
    const s = vecchia[rel];
    const percorso = `${RADICE}/${rel}`;
    let crc: number | null = null;

    if (loc && s && s.ts && s.ts === v.ts && s.size === v.byte && loc.size === v.byte && loc.crc === s.crc) {
      crc = loc.crc; // stessa data e dimensione dell'ultima volta
    } else if (loc && loc.size === v.byte) {
      dice(`Checking ${rel} (${n}/${files.size})…`);
      const st2 = await bleCondiviso.stat(percorso);
      if (st2 && st2.crc === loc.crc) crc = loc.crc;
    }
    if (crc === null) {
      const dati = await bleCondiviso.leggiFile(percorso, (p) => {
        if (p.inviati !== undefined && p.totali) {
          dice(
            `Reading ${rel} (${n}/${files.size})… ${Math.round((p.inviati / p.totali) * 100)}%`,
          );
        }
      });
      await api.ble.mirrorWrite({ rel, dati });
      crc = crc32(dati);
    }
    foto.files[rel] = { size: v.byte, crc, ts: v.ts };
  }

  /* Il deposito delle note protette: `LS` non mostra i nomi col punto, ma
     senza di lui `PRIVATE` non si apre. Il CRC lo dà `STAT`. */
  for (const nome of DEPOSITO) {
    const dep = await bleCondiviso.stat(`${RADICE}/${nome}`);
    const depLoc = locali.get(nome);
    if (dep) {
      if (!depLoc || depLoc.crc !== dep.crc || depLoc.size !== dep.byte) {
        dice("Reading the notes vault…");
        await api.ble.mirrorWrite({
          rel: nome,
          dati: await bleCondiviso.leggiFile(`${RADICE}/${nome}`),
        });
      }
      foto.files[nome] = { size: dep.byte, crc: dep.crc, ts: "" };
    } else if (depLoc) {
      await api.ble.mirrorDelete({ rel: nome });
    }
  }

  /* 3. E via dallo specchio ciò che sul dispositivo non c'è più. */
  for (const f of st.files) {
    if (!DEPOSITO.includes(f.rel) && !files.has(f.rel)) await api.ble.mirrorDelete({ rel: f.rel });
  }
  for (const dir of st.dirs.sort((a, b) => b.length - a.length)) {
    if (!dirs.includes(dir)) await api.ble.mirrorDelete({ rel: dir });
  }

  await api.ble.mirrorSaveSnapshot(foto);
  allineato = true;
  dice("");
  return st.root;
}
