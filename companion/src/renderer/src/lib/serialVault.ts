/**
 * Farsi dare da ORION il deposito delle note protette, sulla console USB —
 * e ridarglielo, se lo ha perso.
 *
 * Il deposito sta nella flash di ORION (dal 10/10/2026) e la Companion ne
 * tiene una copia: questo è il momento in cui la riceve — la prima volta, e
 * dopo ogni cambio di password. Succede di rado; tutti gli altri giorni la
 * Companion legge una sigla dal disco e non apre nessuna porta.
 *
 * Il verso opposto (`ripristinaDepositoSuOrion`) serve dopo una cancellazione
 * completa della flash di ORION: senza, le note protette sulla card non le
 * aprirebbe più il dispositivo che le ha scritte.
 *
 * Il protocollo è nel firmware (`cmd_vault` in `console.c`, e
 * `docs/PIANO_CIFRATURA_NOTE.md` §7c): `vault id`, `vault get`,
 * `vault put <hex>`, e contano solo le righe che cominciano con `ORNV `. Tutto il resto che la console stampa
 * — il banner, il battito, altri moduli — si ignora.
 *
 * ⚠️ **La password non passa di qui.** La chiede ORION sul suo pannello e la
 * si batte sulla sua tastiera; da questa parte arrivano solo gli 88 byte,
 * che senza la password non aprono niente.
 *
 * ⚠️ La porta la sceglie il processo principale (`select-serial-port` in
 * `main/index.ts`): qui `requestPort()` non mostra nessuna finestra.
 */

const ORION_VID = 0xcafe;
const ORION_PID = 0x4003;

/** Se ORION non risponde nemmeno `ORNV WAIT` entro questo tempo, dall'altra
 *  parte c'è un firmware che il comando non lo conosce. */
const PRIMA_RISPOSTA_MS = 5_000;
/** Il tempo di leggere il pannello e battere la password. */
const RISPOSTA_UTENTE_MS = 180_000;

const PERCHE: Record<string, string> = {
  none: "No notes password has been set on this ORION.",
  screen: "ORION must be on its USB screen: on the device, Settings > USB MODE, then try again.",
  denied: "Cancelled on ORION.",
  locked: "ORION locked the notes before sending the key. Try again.",
  exists: "ORION already has a notes key: there is nothing to restore.",
  format: "ORION did not accept the key as sent.",
  flash: "ORION could not store the key.",
};

interface Risposta {
  /** `ID`, `KEY`, `PUT`: la parola dopo `ORNV`. I `NO` diventano eccezioni. */
  cosa: string;
  valore: string;
}

/** Manda un comando e torna la sua risposta `ORNV`. `attesa` è ciò che si
 *  dice all'utente quando ORION risponde `WAIT`, cioè quando tocca a lui. */
type Chiedi = (comando: string, attesa?: string) => Promise<Risposta>;

/** Apre la console di ORION, lascia fare a `lavoro`, e la richiude comunque
 *  vada. Una porta sola per tutta la conversazione. */
async function conOrion<T>(
  dice: (stato: string) => void,
  lavoro: (chiedi: Chiedi) => Promise<T>,
): Promise<T> {
  if (!navigator.serial) throw new Error("This build cannot talk to ORION over USB.");

  let porta: SerialPort;
  try {
    porta = await navigator.serial.requestPort({
      filters: [{ usbVendorId: ORION_VID, usbProductId: ORION_PID }],
    });
  } catch {
    throw new Error("ORION is not connected over USB.");
  }

  try {
    await porta.open({ baudRate: 115200 });
  } catch {
    throw new Error(
      "ORION's console is busy: close any terminal connected to it, then try again.",
    );
  }

  const lettore = porta.readable?.getReader();
  const scrittore = porta.writable?.getWriter();
  let sveglia: ReturnType<typeof setTimeout> | undefined;

  try {
    if (!lettore || !scrittore) throw new Error("ORION's console did not open.");
    /* La console del firmware parla solo a chi alza DTR. */
    await porta.setSignals({ dataTerminalReady: true, requestToSend: true });

    const testo = new TextDecoder("latin1");
    let resto = "";
    let scaduto = false;
    const arma = (ms: number): void => {
      clearTimeout(sveglia);
      sveglia = setTimeout(() => {
        scaduto = true;
        void lettore.cancel();
      }, ms);
    };

    const chiedi: Chiedi = async (comando, attesa) => {
      let inAttesa = false;

      /* Il primo invio chiude una riga eventualmente rimasta a metà. */
      await scrittore.write(new TextEncoder().encode(`\r${comando}\r`));
      arma(PRIMA_RISPOSTA_MS);

      for (;;) {
        const { value, done } = await lettore.read();
        if (done || !value) {
          if (scaduto && !inAttesa) {
            throw new Error("ORION did not answer: its firmware may be too old for this.");
          }
          if (scaduto) throw new Error("No answer from ORION in time. Try again.");
          throw new Error("ORION was disconnected.");
        }
        resto += testo.decode(value, { stream: true });
        const righe = resto.split(/[\r\n]+/);
        resto = righe.pop() ?? "";

        for (const riga of righe) {
          /* Il prompt "> " può precedere la risposta sulla stessa riga. */
          const i = riga.indexOf("ORNV ");
          if (i < 0) continue;
          const [, cosa, valore = ""] = riga.slice(i).trim().split(/\s+/);

          if (cosa === "WAIT") {
            inAttesa = true;
            arma(RISPOSTA_UTENTE_MS);
            if (attesa) dice(attesa);
          } else if (cosa === "NO") {
            throw new Error(PERCHE[valore] ?? `ORION refused (${valore}).`);
          } else {
            clearTimeout(sveglia);
            return { cosa, valore };
          }
        }
      }
    };

    return await lavoro(chiedi);
  } finally {
    clearTimeout(sveglia);
    try {
      await lettore?.cancel();
    } catch {
      /* già chiuso */
    }
    lettore?.releaseLock();
    scrittore?.releaseLock();
    try {
      await porta.close();
    } catch {
      /* già chiusa */
    }
  }
}

/** Gli 88 byte del deposito, in esadecimale, dopo che l'utente ha detto sì
 *  su ORION con la sua password. */
export function chiediDepositoAOrion(dice: (stato: string) => void): Promise<string> {
  return conOrion(dice, async (chiedi) => {
    const r = await chiedi(
      "vault get",
      "Look at ORION: type your notes password on its keyboard and press ENTER.",
    );
    if (r.cosa !== "KEY") throw new Error("ORION answered something unexpected.");
    return r.valore;
  });
}

/**
 * Rimette su ORION il deposito che la Companion aveva in copia.
 *
 * ⚠️ Prima si chiede a ORION cosa ha. Il firmware rifiuterebbe comunque di
 * scrivere sopra un deposito che c'è, ma chiederlo prima permette di dire
 * all'utente QUALE dei due casi è: ha già questa chiave (non c'era niente da
 * fare), o ne ha un'altra (e allora queste note non sono le sue).
 */
export function ripristinaDepositoSuOrion(
  hex: string,
  sigla: string,
  dice: (stato: string) => void,
): Promise<void> {
  return conOrion(dice, async (chiedi) => {
    const ha = await chiedi("vault id");
    if (ha.cosa !== "ID") throw new Error("ORION answered something unexpected.");
    if (ha.valore === sigla) throw new Error("ORION already has this notes key: nothing to restore.");
    if (ha.valore !== "none") {
      throw new Error("ORION has a different notes key. It was not replaced.");
    }
    const r = await chiedi("vault put " + hex, "Look at ORION: press ENTER to accept the notes key.");
    if (r.cosa !== "PUT") throw new Error("ORION answered something unexpected.");
  });
}
