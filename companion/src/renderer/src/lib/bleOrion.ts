/**
 * Trasferimento file verso ORION via Bluetooth Low Energy.
 *
 * ⚠️ **Sta nel renderer e non nel main**, e non e' una scelta: Web Bluetooth
 * e' un'API del browser, e in Electron vive in Chromium. Il main process fa
 * solo da arbitro quando l'utente sceglie il dispositivo (vedi
 * `select-bluetooth-device` in `main/index.ts`): senza quel gancio il
 * selettore non si risolve mai e la `requestDevice()` resta appesa per sempre.
 *
 * ⚠️ **Non c'e' niente da progettare lato radio.** Il modulo FSC-BT631D espone
 * di suo il servizio "transparent" di Feasycom, e il firmware di ORION ha gia'
 * SPP e GATT accesi (`AT+PROFILE=323`, bit 0 e 1). Quello che si scrive sulla
 * caratteristica 0xFFF2 esce dalla UART del modulo come `+GATTDATA=<len>,<...>`
 * e arriva a `ble_dati.c`; quello che il firmware manda con `AT+GATTSEND`
 * torna qui come notifica su 0xFFF1.
 *
 * Il protocollo e il perche' di ogni scelta stanno in `BLE_DATI.md` nel repo
 * del firmware.
 */

/** Servizio "transparent" di Feasycom (guida di programmazione, §3.2). */
const SERVIZIO = 0xfff0;
/** App → modulo. */
const CAR_SCRITTURA = 0xfff2;
/** Modulo → app (notify). */
const CAR_NOTIFICA = 0xfff1;

/**
 * ⚠️ **180 byte, e il numero viene dall'MTU non dal protocollo.** Il modulo
 * accetterebbe 492 byte per comando, ma una scrittura GATT non puo' superare
 * l'MTU negoziato meno tre — e macOS negozia tipicamente 185. Chiedere di piu'
 * non da' un trasferimento piu' veloce: da' una scrittura che **fallisce**.
 *
 * ⚠️ Va misurato sul campo: se l'MTU risultasse piu' alto, alzare questo
 * numero e' il modo piu' diretto di far salire la velocita', perche' ogni
 * pacchetto costa un giro di risposta.
 */
/**
 * ⚠️ **Le misure dicono che il costo e' per scrittura, non per byte.**
 *
 * Con 180 byte per scrittura: 460 B/s. Tenendo otto risposte in volo invece
 * di una: 495 B/s, cioe' **niente**. Se aspettare la risposta non costa, a
 * costare e' la scrittura in se': Web Bluetooth serializza le operazioni GATT
 * e su macOS ogni scrittura aspetta che la periferica sia pronta — una volta
 * per intervallo di connessione, e l'intervallo qui e' ~90 ms.
 *
 * Quindi l'unica leva rimasta e' **quanti byte stanno in una scrittura**. Il
 * modulo ne accetta 492; quanti ne passino davvero dipende dall'MTU, che Web
 * Bluetooth **non espone** — e su macOS una scrittura troppo lunga puo' essere
 * troncata in silenzio invece che rifiutata, che e' il modo peggiore di
 * sbagliare.
 *
 * Per questo la misura la fa il **dispositivo**: `ECHO` risponde con quanti
 * byte ha visto, e si tiene il pacchetto piu' grande che arriva intero.
 */
const PACCHETTI_DA_PROVARE = [492, 400, 300, 244, 180, 120];

/** Il ripiego se la prova non riesce: il valore che ha sempre funzionato. */
const PACCHETTO_MINIMO = 180;

/**
 * Lo stesso problema nell'altro verso: quanto puo' essere lunga una
 * **risposta**. Una notifica piu' lunga dell'MTU arriva tagliata senza
 * errore, e una pagina di elenco tagliata e' un nome di file sbagliato.
 * Si misura con `FILL`, che e' `ECHO` allo specchio.
 */
const RISPOSTE_DA_PROVARE = [480, 400, 300, 244, 180];
/** Il ripiego: una notifica cosi' passa anche con l'MTU minimo di macOS. */
const RISPOSTA_MINIMA = 120;

/** Una voce di cartella, come la da' `LS`. */
export interface VoceBle {
  nome: string;
  cartella: boolean;
  byte: number;
  /** Data e ora FAT, cosi' come stanno nella directory (per confrontare). */
  ts: string;
  /** La stessa, leggibile. Ora locale del dispositivo. */
  mtimeIso: string;
}

function fatIso(ts: string): string {
  const d = parseInt(ts.slice(0, 4), 16);
  const t = parseInt(ts.slice(4, 8), 16);
  const due = (n: number) => String(n).padStart(2, "0");
  if (d === 0) return "";
  return (
    `${1980 + (d >> 9)}-${due((d >> 5) & 15)}-${due(d & 31)}T` +
    `${due(t >> 11)}:${due((t >> 5) & 63)}:${due((t & 31) * 2)}`
  );
}

function daBase64(s: string): Uint8Array {
  const b = atob(s);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

/** Il testo di un `ERR ...` senza il prefisso, per mostrarlo a chi guarda. */
function motivo(r: string): string {
  return r.replace(/^ERR\s*/, "") || "errore";
}

/**
 * ⚠️ **Quanti pacchetti si mandano prima di aspettare le risposte.**
 *
 * E' la cosa che decide la velocita', e il perche' sta in un numero misurato:
 * aspettando una risposta per pacchetto si andava a **460 byte al secondo**,
 * cioe' 294 ms per pacchetto. Quasi tutto quel tempo non e' nostro: e'
 * l'**intervallo di connessione** BLE che macOS negozia, e che qui risulta di
 * ~90 ms. Si pagava tre volte — scrittura, notifica di risposta, pacchetto
 * successivo — e il modulo non ha nessun comando per chiedere un intervallo
 * piu' corto: quello lo decide il computer.
 *
 * Con otto pacchetti in volo quel costo si divide per otto e il collo di
 * bottiglia torna a essere la UART del modulo (11,5 kB/s a 115200).
 *
 * ⚠️ **Il limite e' dall'altra parte, ed e' un prodotto**: quello che conta
 * non e' quanti pacchetti stanno in volo ma **quanti byte**, perche' finiscono
 * tutti nell'anello di ricezione del firmware, che e' di 2048 byte
 * (`BLE_RX_N` in `ble.h`). Otto pacchetti da 180 byte sono 1568 e stanno; otto
 * da 492 sono 4064 e **traboccano**, e i byte persi non tornano indietro.
 *
 * ⚠️ Il 23/9/2026 e' successo esattamente questo: la misura del pacchetto e'
 * passata da 180 a 492 e la finestra e' rimasta otto. Il sintomo era "nessuna
 * risposta a DATA ...", cioe' un pacchetto mai arrivato — non un errore del
 * dispositivo, un pacchetto **caduto dentro l'anello pieno**.
 *
 * Quindi la finestra non e' piu' un numero: si calcola da quanto e' grande il
 * pacchetto (`finestra` qui sotto). Otto resta il tetto, perche' oltre non
 * serve.
 */
/**
 * ⚠️ **Uno, e il motivo e' dall'altra parte della radio** (23/9/2026).
 *
 * Con la finestra a otto — e poi a tre, dopo la correzione dell'anello — un
 * pacchetto spariva lo stesso, in punti diversi del file. Il sospetto che
 * regge e' che a perdersi non sia il **dato** ma la **risposta**: il
 * dispositivo risponde a ogni `DATA` con un `AT+GATTSEND`, e il modulo puo'
 * mandare **una notifica per intervallo di connessione** (~90 ms su macOS).
 * Con tre risposte sparate di fila, le ultime due non hanno dove andare.
 *
 * ⚠️ E rilegge male una misura del 22/9: *"la finestra non ha spostato niente
 * — 460 contro 495 B/s"*. Allora l'ho spiegata col costo per scrittura. La
 * spiegazione piu' semplice e' che **la finestra non ha mai funzionato**: i
 * pacchetti oltre il primo si perdevano gia' allora, e i trasferimenti a piu'
 * pacchetti non sono mai arrivati in fondo — l'ebook del 22/9 rimasto
 * "APERTO" a 1048 byte e' la stessa cosa.
 *
 * La leva vera sulla velocita' resta il **pacchetto**: 492 byte invece di 180
 * sono un terzo delle scritture, ed e' il costo che si paga davvero.
 *
 * Il calcolo sull'anello resta qui sotto, e vale il giorno che si dimostri
 * che il modulo regge piu' notifiche in volo: allora basta alzare questo tetto.
 */
const FINESTRA_MAX = 1;

/**
 * Quanto dell'anello di ricezione del firmware si usa davvero. L'anello e'
 * `BLE_RX_N` in `Core/Inc/ble.h`, oggi **2048** byte.
 * ⚠️ I 448 byte di margine non sono prudenza generica: mentre il dispositivo
 * manda un frame al pannello (75 ms) **non drena la UART**, e a 115200 in
 * 75 ms arrivano ~860 byte. Il margine e' quello — e sta stretto apposta, per
 * non rallentare oltre il necessario.
 */
const ANELLO_USABILE = 1600;

/** Byte che un pacchetto occupa sulla UART del modulo: `+GATTDATA=nnn,` + CR/LF. */
const SPESA_AT = 16;

/** Quanti pacchetti si possono tenere in volo senza far traboccare l'anello. */
export function finestraPer(pacchettoB64: number): number {
  const quanti = Math.floor(ANELLO_USABILE / (pacchettoB64 + SPESA_AT));
  return Math.max(1, Math.min(FINESTRA_MAX, quanti));
}

export interface ProgressoBle {
  fase: "connessione" | "invio" | "fatto" | "errore";
  file?: string;
  inviati?: number;
  totali?: number;
  /** Byte al secondo, misurati sul trasferimento in corso. */
  velocita?: number;
  errore?: string;
}

export type EmettiProgresso = (p: ProgressoBle) => void;

/** CRC32 come zlib (polinomio riflesso). Deve combaciare con `crc32_agg()`
 *  del firmware: se divergono, ogni trasferimento finisce con "ERR crc". */
export function crc32(dati: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < dati.length; i++) {
    crc ^= dati[i];
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Quanti byte di dati veri stanno in una scrittura da `pacchettoB64`, dato il
 * prefisso del comando. Sta fuori dalla classe per poterlo provare senza un
 * Bluetooth: e' aritmetica, ed e' proprio l'aritmetica che si era sbagliata.
 */
export function passoDati(pacchettoB64: number, prefisso: string): number {
  const perB64 = pacchettoB64 - prefisso.length;
  return Math.max(3, Math.floor(perB64 / 4) * 3);
}

/** Quanto diventa lunga la scrittura per `n` byte di dati col prefisso dato. */
export function lunghezzaScrittura(n: number, prefisso: string): number {
  return prefisso.length + Math.ceil(n / 3) * 4;
}

export const PACCHETTI_PROVATI = PACCHETTI_DA_PROVARE;

function base64(dati: Uint8Array): string {
  let s = "";
  for (let i = 0; i < dati.length; i++) s += String.fromCharCode(dati[i]);
  return btoa(s);
}

export class OrionBle {
  private dispositivo: BluetoothDevice | null = null;
  private scrittura: BluetoothRemoteGATTCharacteristic | null = null;
  private notifica: BluetoothRemoteGATTCharacteristic | null = null;

  /** ⚠️ **Una coda, non un puntatore solo.** Con la finestra ci sono piu'
   *  comandi in volo insieme, e le risposte tornano **nell'ordine in cui sono
   *  partite** — il collegamento BLE non riordina e il firmware serve i
   *  pacchetti in fila. Chi arriva per primo prende la prima attesa. */
  private attese: ((riga: string) => void)[] = [];

  /**
   * ⚠️ **Web Bluetooth ammette UNA operazione GATT per volta**, per
   * dispositivo. Non e' un limite del Bluetooth: e' dell'API. Mandare la
   * seconda scrittura prima che la prima abbia risolto fa fallire tutto con
   * *"GATT operation already in progress"*.
   *
   * Quindi le **scritture** si incatenano qui, una dopo l'altra. Ma le
   * **risposte** no: sono quelle che si possono tenere in volo, ed e' li' che
   * stanno i ~90 ms di intervallo di connessione che volevamo smettere di
   * pagare a ogni pacchetto. La finestra continua a funzionare — quello che
   * cambia e' che non si aspetta la *risposta*, non che si mandino piu'
   * scritture insieme.
   */
  private catenaScritture: Promise<unknown> = Promise.resolve();

  /** true se 0xFFF2 dichiara "write without response". Letto alla
   *  connessione: e' una proprieta' della caratteristica, non una nostra
   *  preferenza. */
  private senzaRisposta = false;

  /** Byte di base64 per scrittura, deciso da `misuraPacchetto()`. */
  private pacchettoB64 = PACCHETTO_MINIMO;

  /** Caratteri per risposta, deciso da `misuraRisposta()`. */
  private rispostaMax = RISPOSTA_MINIMA;

  /** Versione del protocollo detta dal dispositivo. 2 = si puo' navigare la
   *  scheda (`LS`, `READ`, `DEL`, `REN`, `MKD`). */
  private versioneProto = 0;
  private liberi = 0;

  /** Chi vuole sapere quando la connessione cambia (le pagine). */
  private ascoltatori = new Set<() => void>();

  suCambio(cb: () => void): () => void {
    this.ascoltatori.add(cb);
    return () => this.ascoltatori.delete(cb);
  }

  private avvisa(): void {
    for (const cb of [...this.ascoltatori]) cb();
  }

  get versione(): number {
    return this.versioneProto;
  }

  /** kB liberi sulla scheda, all'ultimo `PING`. */
  get liberiKb(): number {
    return this.liberi;
  }

  /** true se il firmware sa navigare la scheda. */
  get naviga(): boolean {
    return this.connesso && this.versioneProto >= 2;
  }

  /**
   * Quanti byte di dati veri stanno in una scrittura, **prefisso compreso**.
   *
   * ⚠️ Il bug del 23/9/2026: qui c'era `pacchettoB64 / 4 * 3`, che ignorava i
   * 5 caratteri di `"DATA "`. La scrittura usciva quindi di **5 byte** oltre
   * la misura fatta da `misuraPacchetto()` — e una scrittura piu' lunga
   * dell'MTU su macOS **non viene rifiutata: viene troncata in silenzio**.
   * Il base64 troncato decodifica lo stesso, solo piu' corto: ogni pacchetto
   * perdeva un paio di byte, nessun `DATA` dava errore, e il conto non
   * tornava solo alla fine, con un "ERR byte mancanti" che sembrava arrivare
   * dal nulla.
   * ⚠️ Spiega anche il trasferimento di ebook del 22/9 rimasto "APERTO" a
   * 1048 byte: era lo stesso troncamento, mai diagnosticato.
   */
  private budgetDati(prefisso: string): number {
    return passoDati(this.pacchettoB64, prefisso);
  }

  /** Il pacchetto scelto, per mostrarlo a chi guarda. */
  get pacchetto(): number {
    return this.pacchettoB64;
  }

  get connesso(): boolean {
    return this.dispositivo?.gatt?.connected === true;
  }

  get nome(): string {
    return this.dispositivo?.name ?? "";
  }

  async connetti(): Promise<void> {
    this.dispositivo = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVIZIO] }],
      optionalServices: [SERVIZIO],
    });

    const server = await this.dispositivo.gatt!.connect();
    const servizio = await server.getPrimaryService(SERVIZIO);

    this.scrittura = await servizio.getCharacteristic(CAR_SCRITTURA);
    this.notifica = await servizio.getCharacteristic(CAR_NOTIFICA);

    this.senzaRisposta =
      this.scrittura.properties?.writeWithoutResponse === true;

    /* Una connessione nuova comincia con la coda vuota: se la precedente e'
       finita male, le sue attese non devono sopravviverle. */
    this.attese = [];
    this.catenaScritture = Promise.resolve();

    await this.notifica.startNotifications();
    this.notifica.addEventListener("characteristicvaluechanged", (ev) => {
      const v = (ev.target as BluetoothRemoteGATTCharacteristic).value!;
      const riga = new TextDecoder().decode(v).trim();
      const chi = this.attese.shift();
      if (chi) chi(riga);
    });

    /* ⚠️ La misura si fa **qui**, non nella pagina: chi si connette da
       un'altra schermata non puo' dimenticarsene, e senza misura si resta al
       minimo di sicurezza. Costa qualche decimo di secondo, una volta. */
    this.pacchettoB64 = PACCHETTO_MINIMO;
    await this.misuraPacchetto().catch(() => PACCHETTO_MINIMO);

    /* E il saluto: dice se il firmware sa navigare la scheda, e in quel
       caso si misura anche quanto puo' essere lunga una risposta. */
    this.rispostaMax = RISPOSTA_MINIMA;
    this.versioneProto = 0;
    try {
      const p = await this.ping();
      this.versioneProto = p.versione;
      this.liberi = p.liberiKb;
      if (p.versione >= 2) await this.misuraRisposta();
    } catch {
      /* Un dispositivo che non risponde al saluto resta connesso: i
         trasferimenti semplici non ne hanno bisogno. */
    }

    this.dispositivo.addEventListener("gattserverdisconnected", () => {
      this.scrittura = null;
      this.notifica = null;
      this.avvisa();
    });
    this.avvisa();
  }

  disconnetti(): void {
    this.dispositivo?.gatt?.disconnect();
    this.dispositivo = null;
    this.scrittura = null;
    this.notifica = null;
    this.avvisa();
  }

  /** Come `misuraPacchetto()`, nell'altro verso. */
  private async misuraRisposta(): Promise<number> {
    for (const n of RISPOSTE_DA_PROVARE) {
      try {
        const r = await this.comando(`FILL ${n}`, 5000);
        if (r.startsWith("FILL ") && r.length === n) {
          this.rispostaMax = n;
          return n;
        }
      } catch {
        /* nessuna risposta = troppo lunga, come una tagliata */
      }
    }
    this.rispostaMax = RISPOSTA_MINIMA;
    return RISPOSTA_MINIMA;
  }

  private vuoleNavigare(): void {
    if (!this.connesso) throw new Error("Bluetooth not connected.");
    if (this.versioneProto < 2) {
      throw new Error(
        "The firmware on this ORION is too old to browse the card over Bluetooth: update it.",
      );
    }
  }

  /**
   * Il contenuto di una cartella, cartelle comprese.
   *
   * ⚠️ A pagine, una risposta per domanda: e' l'unica forma che il
   * collegamento porta in modo sicuro (vedi `cmd_ls` nel firmware). I nomi
   * che cominciano con un punto non arrivano.
   */
  async ls(cartella: string): Promise<VoceBle[]> {
    this.vuoleNavigare();
    const fuori: VoceBle[] = [];
    let salta = 0;
    for (;;) {
      const r = await this.comando(`LS ${salta} ${this.rispostaMax} ${cartella}`);
      if (r.startsWith("ERR")) throw new Error(motivo(r));
      const taglio = r.indexOf("|");
      const testa = taglio < 0 ? r : r.slice(0, taglio);
      const corpo = taglio < 0 ? "" : r.slice(taglio);
      const m = testa.match(/^OK (\d+) (\d+) ([01]) (\d+)$/);
      if (!m) throw new Error(`risposta inattesa a LS: ${r.slice(0, 40)}`);
      const voci = corpo ? corpo.slice(1).split("|") : [];
      /* Il guardiano del taglio: una pagina arrivata corta non si usa. */
      if (corpo.length !== Number(m[4]) || voci.length !== Number(m[2])) {
        throw new Error("the folder listing arrived cut short: try again");
      }
      for (const v of voci) {
        const mm = v.match(/^([DF])(\d+),([0-9A-Fa-f]{8}),(.*)$/);
        if (!mm) throw new Error(`voce inattesa in LS: ${v.slice(0, 40)}`);
        fuori.push({
          cartella: mm[1] === "D",
          byte: Number(mm[2]),
          ts: mm[3].toUpperCase(),
          mtimeIso: fatIso(mm[3]),
          nome: mm[4],
        });
      }
      salta += Number(m[1]);
      if (m[3] === "0") break;
      if (Number(m[1]) === 0) throw new Error("LS: nessun avanzamento");
    }
    return fuori;
  }

  /**
   * Legge un file dalla scheda. Per file piccoli: qualche centinaio di byte
   * al secondo. Il CRC dell'insieme si confronta con quello di `STAT`.
   */
  async leggiFile(percorso: string, emetti?: EmettiProgresso): Promise<Uint8Array> {
    this.vuoleNavigare();
    const st = await this.stat(percorso);
    if (!st) throw new Error(`not on the card: ${percorso}`);
    const dati = new Uint8Array(st.byte);
    const passo = Math.min(342, Math.floor((this.rispostaMax - 3) / 4) * 3);
    const t0 = performance.now();
    let letti = 0;
    while (letti < st.byte) {
      const r = await this.comando(`READ ${letti} ${passo} ${percorso}`);
      if (!r.startsWith("OK")) throw new Error(motivo(r));
      const pezzo = daBase64(r.slice(3));
      if (pezzo.length === 0) break;
      if (letti + pezzo.length > st.byte) throw new Error("the file changed while reading");
      dati.set(pezzo, letti);
      letti += pezzo.length;
      emetti?.({
        fase: "invio",
        file: percorso,
        inviati: letti,
        totali: st.byte,
        velocita: letti / ((performance.now() - t0) / 1000),
      });
    }
    if (letti !== st.byte || crc32(dati) !== st.crc) {
      throw new Error(`read check failed for ${percorso}: try again`);
    }
    return dati;
  }

  /** Cancella un file, o una cartella **vuota**. */
  async cancella(percorso: string): Promise<void> {
    this.vuoleNavigare();
    const r = await this.comando(`DEL ${percorso}`);
    if (!r.startsWith("OK")) throw new Error(motivo(r));
  }

  /** Rinomina o sposta. Se la destinazione esiste, il dispositivo rifiuta. */
  async rinomina(da: string, a: string): Promise<void> {
    this.vuoleNavigare();
    const r = await this.comando(`REN ${da}|${a}`);
    if (!r.startsWith("OK")) throw new Error(motivo(r));
  }

  async creaCartella(percorso: string): Promise<void> {
    this.vuoleNavigare();
    const r = await this.comando(`MKD ${percorso}`);
    if (!r.startsWith("OK")) throw new Error(motivo(r));
  }

  /** Quanti byte al secondo ci si puo' aspettare in invio, per avvisare
   *  prima di un file grosso. ~290 ms a scrittura, misurati. */
  get velocitaStimata(): number {
    return passoDati(this.pacchettoB64, "DATA ") / 0.29;
  }

  /**
   * Manda un comando e torna la **promessa** della sua risposta.
   *
   * ⚠️ Non aspetta: chi chiama decide se aspettare subito (i comandi di
   * controllo) o tenerne in volo un po' (i pacchetti di dati). E' questa la
   * differenza fra 460 byte al secondo e qualche migliaio.
   */
  private manda(testo: string, timeoutMs = 8000): Promise<string> {
    if (!this.scrittura) throw new Error("non connesso");

    /* ⚠️ **Il guardiano del troncamento.** Una scrittura piu' lunga dell'MTU
       non da' errore: arriva a meta'. Meglio fermarsi qui con un messaggio
       che dice cosa e' successo, che mandare dati che si perdono per strada e
       scoprirlo alla fine come "byte mancanti". */
    if (testo.length > this.pacchettoB64) {
      throw new Error(
        `scrittura da ${testo.length} byte oltre il pacchetto misurato ` +
        `(${this.pacchettoB64}): verrebbe troncata in silenzio`,
      );
    }

    const risposta = new Promise<string>((res, rej) => {
      const attesa = (riga: string) => {
        clearTimeout(t);
        res(riga);
      };
      const t = setTimeout(() => {
        /* ⚠️ **L'attesa scaduta si toglie dalla coda.** Senza questa riga una
           sola risposta in ritardo avvelenava tutta la sessione: la risposta
           successiva andava all'attesa morta, quella dopo a quella sbagliata,
           e da li' in poi **ogni** comando finiva in timeout. E' il motivo per
           cui, quando il primo file falliva, fallivano anche tutti i
           successivi — compresa una nota da 51 byte. */
        const i = this.attese.indexOf(attesa);
        if (i >= 0) this.attese.splice(i, 1);
        rej(new Error(`nessuna risposta a "${testo.slice(0, 20)}"`));
      }, timeoutMs);
      this.attese.push(attesa);
    });

    const dati = new TextEncoder().encode(testo);

    /* ⚠️ **Senza risposta, ma solo se la caratteristica lo dichiara.** Una
       scrittura "con risposta" pretende un giro di ATT tutto suo, cioe' un
       intervallo di connessione in piu' per ogni pacchetto; quella senza ne fa
       stare piu' di una nello stesso intervallo.
       ⚠️ E il controllo va fatto su `properties`, non sull'esistenza del
       metodo: il metodo c'e' **sempre** in Chromium, e su una caratteristica
       che non lo supporta fallisce — o, peggio, il dato sparisce e si vede
       come "nessuna risposta", che manda a cercare dall'altra parte. */
    const car = this.scrittura;
    const scrivi = this.catenaScritture.then(() =>
      this.senzaRisposta
        ? car.writeValueWithoutResponse(dati)
        : car.writeValueWithResponse(dati),
    );

    /* La catena non si deve fermare su un errore, o da li' in poi nessuna
       scrittura parte piu'. */
    this.catenaScritture = scrivi.catch(() => undefined);

    return scrivi.then(
      () => risposta,
      (e) => {
        /* Anche una scrittura fallita deve togliere la sua attesa, o la coda
           resta disallineata. */
        this.attese.pop();
        throw e;
      },
    );
  }

  /** Manda e aspetta: per i comandi di controllo, che sono uno per volta. */
  private comando(testo: string, timeoutMs = 8000): Promise<string> {
    return this.manda(testo, timeoutMs);
  }

  /**
   * Prova quanto grande puo' essere una scrittura, chiedendolo al dispositivo.
   *
   * ⚠️ Si parte dal piu' grande e si scende al primo che torna intero: le
   * scritture troppo lunghe possono essere **troncate senza errore**, quindi
   * l'unica prova che vale e' contare i byte arrivati dall'altra parte.
   */
  async misuraPacchetto(): Promise<number> {
    for (const n of PACCHETTI_DA_PROVARE) {
      /* Il comando e' `ECHO ` + riempimento: si misura la scrittura intera,
         che e' quello che poi costera' davvero. */
      const riempi = "A".repeat(n - 5);
      /* ⚠️ Il pacchetto si alza **prima** di provarlo: `manda()` rifiuta le
         scritture piu' lunghe del pacchetto corrente — e' il guardiano contro
         il troncamento silenzioso — e senza questa riga la sonda non potrebbe
         mai provare niente di piu' grande del minimo. Se la prova fallisce si
         passa alla dimensione sotto, e l'ultima riga rimette il minimo. */
      this.pacchettoB64 = n;
      try {
        const r = await this.comando(`ECHO ${riempi}`, 5000);
        const m = r.match(/^ECHO (\d+)/);
        if (m && Number(m[1]) === riempi.length) {
          this.pacchettoB64 = n;
          return n;
        }
      } catch {
        /* Una scrittura rifiutata e' un "troppo grande" come un altro. */
      }
    }
    this.pacchettoB64 = PACCHETTO_MINIMO;
    return PACCHETTO_MINIMO;
  }

  /** Un saluto: dice la versione del protocollo e lo spazio libero in kB. */
  async ping(): Promise<{ versione: number; liberiKb: number }> {
    const r = await this.comando("PING");
    const m = r.match(/^PONG (\d+) (\d+)/);
    if (!m) throw new Error(`risposta inattesa al PING: ${r}`);
    this.liberi = Number(m[2]);
    return { versione: Number(m[1]), liberiKb: Number(m[2]) };
  }

  /**
   * Dimensione e CRC32 di un file **gia' sulla scheda**, o `null` se non c'e'.
   *
   * ⚠️ Serve a **non mandare niente**: se combacia con quello che manderemmo,
   * il trasferimento non parte. Su un calendario da 30 kB sono mezzo secondo
   * invece di un minuto, e un calendario si risincronizza spesso — quasi
   * sempre senza che sia cambiato niente.
   */
  async stat(percorso: string): Promise<{ byte: number; crc: number } | null> {
    const r = await this.comando(`STAT ${percorso}`);
    if (r.startsWith("ERR")) return null;
    const m = r.match(/^OK (\d+) ([0-9A-Fa-f]{8})/);
    if (!m) throw new Error(`risposta inattesa a STAT: ${r}`);
    return { byte: Number(m[1]), crc: parseInt(m[2], 16) };
  }

  /**
   * Mette l'orologio del dispositivo all'ora **locale di questo computer**.
   *
   * ⚠️ Non si converte niente: l'orologio del PMIC conta ore locali e basta,
   * come gli orari dentro il `.cal`. E va fatto prima di mandare un
   * calendario: con l'orologio sbagliato il dispositivo non sa che giorno
   * evidenziare, e lo dice invece di indovinare.
   */
  async mandaOra(quando = new Date()): Promise<void> {
    const due = (n: number) => String(n).padStart(2, "0");
    const t =
      `${quando.getFullYear()}-${due(quando.getMonth() + 1)}-${due(quando.getDate())} ` +
      `${due(quando.getHours())}:${due(quando.getMinutes())}:${due(quando.getSeconds())}`;
    const r = await this.comando(`TIME ${t}`);
    if (!r.startsWith("OK")) throw new Error(r);
  }

  /**
   * Manda un file **se e' diverso** da quello che c'e' gia'. Ritorna `false`
   * se non c'era niente da fare.
   */
  async inviaSeDiverso(
    percorso: string,
    dati: Uint8Array,
    emetti?: EmettiProgresso,
  ): Promise<boolean> {
    const gia = await this.stat(percorso);
    if (gia && gia.byte === dati.length && gia.crc === crc32(dati)) return false;
    await this.inviaFile(percorso, dati, emetti);
    return true;
  }

  /**
   * Manda un file. `percorso` e' assoluto sulla microSD: `/notes/x.txt`.
   *
   * ⚠️ Il dispositivo scrive su `<percorso>.part` e rinomina **solo** se il
   * CRC torna: un trasferimento interrotto non lascia un file che sembra buono.
   */
  async inviaFile(
    percorso: string,
    dati: Uint8Array,
    emetti?: EmettiProgresso,
  ): Promise<void> {
    const t0 = performance.now();

    const apri = await this.comando(`OPEN ${dati.length} ${percorso}`);
    if (!apri.startsWith("OK")) throw new Error(apri);

    /* ⚠️ **La finestra.** Si tengono in volo fino a `FINESTRA` pacchetti: il
       PC ne manda uno nuovo ogni volta che ne torna indietro uno, invece di
       fermarsi a ogni giro. E' l'unico modo di non pagare l'intervallo di
       connessione una volta per pacchetto.
       La risposta a `DATA` porta il **totale** dei byte arrivati, non un
       "ricevuto": cosi' l'avanzamento e' quello vero del dispositivo, e una
       risposta letta in ritardo non fa contare due volte. */
    let inviati = 0;
    const passo = this.budgetDati("DATA ");
    const finestra = finestraPer(this.pacchettoB64);
    const inVolo: Promise<string>[] = [];

    const raccogli = async (): Promise<void> => {
      const r = await inVolo.shift()!;
      if (!r.startsWith("OK")) throw new Error(r);
      const n = Number(r.slice(3));
      if (Number.isFinite(n)) inviati = n;
      emetti?.({
        fase: "invio",
        file: percorso,
        inviati,
        totali: dati.length,
        velocita: inviati / ((performance.now() - t0) / 1000),
      });
    };

    /* ⚠️ Qualunque cosa vada storta, il dispositivo va avvisato: senza
       `ABORT` gli resta un file aperto e un `.part` sulla scheda, e il
       comando di banco `bledati` dice "trasferimento APERTO" per sempre. Il
       prossimo `OPEN` lo recupererebbe comunque, ma lasciare in giro un file
       a meta' quando si sa gia' che non serve e' sciatteria. */
    try {
      for (let i = 0; i < dati.length; i += passo) {
        const pezzo = dati.subarray(i, i + passo);
        inVolo.push(this.manda(`DATA ${base64(pezzo)}`));
        if (inVolo.length >= finestra) await raccogli();
      }
      while (inVolo.length > 0) await raccogli();
    } catch (e) {
      await this.comando("ABORT", 4000).catch(() => undefined);
      throw e;
    }

    const crc = crc32(dati).toString(16).padStart(8, "0");
    const fine = await this.comando(`DONE ${crc}`, 20000);
    if (!fine.startsWith("OK")) throw new Error(fine);

    emetti?.({
      fase: "fatto",
      file: percorso,
      inviati,
      totali: dati.length,
      velocita: dati.length / ((performance.now() - t0) / 1000),
    });
  }

  /** L'elenco di una cartella della scheda. */
  async elenco(cartella: string): Promise<{ nome: string; byte: number }[]> {
    const fuori: { nome: string; byte: number }[] = [];

    /* ⚠️ `LIST` risponde con **piu'** righe e chiude con `END`, quindi non
       passa da `comando()` che ne aspetta una sola. */
    if (!this.scrittura) throw new Error("non connesso");

    const finito = new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("elenco: nessuna risposta")), 8000);
      const passo = (riga: string) => {
        if (riga === "END" || riga.startsWith("ERR")) {
          clearTimeout(t);
          if (riga.startsWith("ERR")) rej(new Error(riga));
          else res();
          return;
        }
        const m = riga.match(/^F (\d+) (.*)$/);
        if (m) fuori.push({ byte: Number(m[1]), nome: m[2] });
        /* `LIST` risponde con piu' righe: ci si rimette in coda finche' non
           arriva `END`. */
        this.attese.push(passo);
      };
      this.attese.push(passo);
    });

    await this.scrittura.writeValueWithResponse(
      new TextEncoder().encode(`LIST ${cartella}`),
    );
    await finito;
    return fuori;
  }
}

/** Dove va un file, in base all'estensione. Le stesse cartelle che usa la
 *  scheda quando si copia via USB. */
/**
 * ⚠️ **Una connessione sola per tutta l'app.** Web Bluetooth apre il suo
 * pannello di scelta a ogni `requestDevice()`, e un secondo `OrionBle` da
 * un'altra pagina vorrebbe dire richiedere il dispositivo una seconda volta
 * mentre il primo e' gia' connesso. Le pagine Bluetooth e Calendar usano
 * questa, non la loro.
 */
export const bleCondiviso = new OrionBle();
