import { useCallback, useEffect, useState, type DragEvent } from "react";
import {
  AlertTriangle,
  Bluetooth,
  CalendarDays,
  Check,
  FileUp,
  HardDriveDownload,
  Lock,
  RefreshCw,
  X,
} from "lucide-react";
import { bleCondiviso } from "@/lib/bleOrion";
import { useDevices } from "@/lib/DeviceContext";
import { api, isElectron } from "@/lib/api";
import type {
  CalendarioAnteprima,
  CalendarioVoce,
} from "@shared/ipc-types";

/* Finestra temporale mandata al dispositivo. Non e' "tutto": un calendario
   intero sarebbe grande e per lo piu' passato. */
const INDIETRO_GIORNI = 7;
const AVANTI_SCELTE = [30, 90, 180, 365];
const CHIAVE_SCELTI = "orion.calendario.scelti";
const CHIAVE_AVANTI = "orion.calendario.avanti";

function byte(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

const CalendarPage = () => {
  const { devices } = useDevices();
  const device = devices[0] ?? null;

  const [stato, setStato] = useState<string>("");
  const [calendari, setCalendari] = useState<CalendarioVoce[]>([]);
  const [scelti, setScelti] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(CHIAVE_SCELTI) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const [avanti, setAvanti] = useState<number>(() =>
    Number(localStorage.getItem(CHIAVE_AVANTI) ?? 90),
  );
  /* ⚠️ Un `.ics` trascinato **sostituisce** il Calendario di sistema come
     sorgente. E' la strada per Windows e Linux, dove il calendario di sistema
     non e' raggiungibile da un'app non impacchettata, e per chi su macOS non
     vuole concedere il permesso: da qui in giu' il percorso e' identico. */
  const [ics, setIcs] = useState<string | null>(null);
  const [sopra, setSopra] = useState(false);
  const [anteprima, setAnteprima] = useState<CalendarioAnteprima | null>(null);
  const [occupato, setOccupato] = useState(false);
  const [esito, setEsito] = useState<string>("");

  useEffect(() => {
    localStorage.setItem(CHIAVE_SCELTI, JSON.stringify(scelti));
  }, [scelti]);
  useEffect(() => {
    localStorage.setItem(CHIAVE_AVANTI, String(avanti));
  }, [avanti]);

  const carica = useCallback(async () => {
    if (!isElectron) return;
    setOccupato(true);
    try {
      const r = await api.calendario.elenco();
      if (!r.ok) {
        setStato(r.errore ?? "non riesco a leggere i calendari");
        setCalendari([]);
        return;
      }
      setStato("");
      setCalendari(r.calendari);
      /* ⚠️ Di default **nessun calendario**: quello di lavoro e quello di
         famiglia non devono fare la stessa fine per una svista. */
      setScelti((s) => s.filter((id) => r.calendari.some((c) => c.id === id)));
    } finally {
      setOccupato(false);
    }
  }, []);

  useEffect(() => {
    void carica();
  }, [carica]);

  const chiediPermesso = async () => {
    setOccupato(true);
    try {
      const r = await api.calendario.permesso();
      setStato(r.ok ? "" : `accesso al Calendario: ${r.stato}`);
      if (r.ok) await carica();
    } finally {
      setOccupato(false);
    }
  };

  const guarda = useCallback(async () => {
    if (!ics && scelti.length === 0) {
      setAnteprima(null);
      return;
    }
    setOccupato(true);
    try {
      const a = await api.calendario.anteprima({
        calendari: scelti,
        indietro: INDIETRO_GIORNI,
        avanti,
        ics: ics ?? undefined,
      });
      setAnteprima(a);
      if (!a.ok) setStato(a.errore ?? "");
    } finally {
      setOccupato(false);
    }
  }, [scelti, avanti, ics]);

  useEffect(() => {
    void guarda();
  }, [guarda]);

  const manda = async () => {
    if (!device?.mountPath || (!ics && scelti.length === 0)) return;
    setOccupato(true);
    setEsito("");
    try {
      const r = await api.calendario.scrivi({
        mountPath: device.mountPath,
        calendari: scelti,
        indietro: INDIETRO_GIORNI,
        avanti,
        ics: ics ?? undefined,
      });
      setEsito(
        r.ok
          ? `Written: ${r.info?.eventi ?? 0} entries, ${byte(r.info?.byte ?? 0)} → ${r.percorso}`
          : `Failed: ${r.errore}`,
      );
    } finally {
      setOccupato(false);
    }
  };

  /**
   * Via radio, senza cavo. Tre passi in un pulsante:
   *   1. l'orologio, perche' un calendario con la data sbagliata e' inutile e
   *      il dispositivo lo dice invece di indovinare;
   *   2. `STAT`, per non mandare un file identico a quello che c'e' gia';
   *   3. il trasferimento vero, solo se serve.
   */
  const mandaBle = async () => {
    if (!ics && scelti.length === 0) return;
    setOccupato(true);
    setEsito("");
    try {
      const r = await api.calendario.dati({
        calendari: scelti,
        indietro: INDIETRO_GIORNI,
        avanti,
        ics: ics ?? undefined,
      });
      if (!r.ok || !r.dati) {
        setEsito(`Failed: ${r.errore}`);
        return;
      }
      if (!bleCondiviso.connesso) {
        setEsito("Connecting...");
        await bleCondiviso.connetti();
      }
      await bleCondiviso.mandaOra();
      const dati = new Uint8Array(r.dati);
      const cambiato = await bleCondiviso.inviaSeDiverso(
        "/calendar/calendar.cal",
        dati,
        (p) => {
          if (p.inviati === undefined || !p.totali) return;
          setEsito(`Sending... ${Math.round((p.inviati / p.totali) * 100)}%`);
        },
      );
      setEsito(
        cambiato
          ? `Sent over Bluetooth: ${r.info?.eventi ?? 0} entries, ${byte(dati.length)}`
          : "Already up to date on the device: nothing sent.",
      );
    } catch (e) {
      setEsito(`Failed: ${String(e)}`);
    } finally {
      setOccupato(false);
    }
  };

  const lascia = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setSopra(false);
    const f = Array.from(e.dataTransfer.files).find((x) =>
      x.name.toLowerCase().endsWith(".ics"),
    );
    if (!f) {
      setEsito("Not an .ics file.");
      return;
    }
    setIcs(api.fs.getPathForFile(f));
    setEsito("");
  };

  const commuta = (id: string) =>
    setScelti((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  if (!isElectron) {
    return <p className="text-sm text-zinc-500">Only available in the desktop app.</p>;
  }

  return (
    <div className="flex h-full flex-col gap-5 overflow-auto">
      {stato && (
        <div className="ui-card flex items-start gap-3 p-4">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <div className="text-sm">
            <p className="text-zinc-800 dark:text-zinc-200">{stato}</p>
            <button
              type="button"
              onClick={chiediPermesso}
              disabled={occupato}
              className="mt-2 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Grant access to Calendar
            </button>
          </div>
        </div>
      )}

      <div className="ui-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            <CalendarDays className="h-4 w-4" /> Calendars to sync
          </h3>
          <button
            type="button"
            onClick={() => void carica()}
            disabled={occupato}
            className="flex items-center gap-1.5 rounded-md border border-zinc-200 px-2.5 py-1 text-xs text-zinc-600 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${occupato ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {ics ? (
          <p className="text-sm text-zinc-500">
            Using the imported file instead. Remove it below to go back to the
            system calendars.
          </p>
        ) : calendari.length === 0 ? (
          <p className="text-sm text-zinc-500">No calendars found.</p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2">
            {calendari.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <input
                    type="checkbox"
                    checked={scelti.includes(c.id)}
                    onChange={() => commuta(c.id)}
                    className="h-4 w-4"
                  />
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: c.colore || "#888" }}
                  />
                  <span className="truncate text-sm text-zinc-800 dark:text-zinc-200">
                    {c.nome}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-zinc-400">
                    {c.conto}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-4 flex items-center gap-2 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-700">
          <span className="text-zinc-500">Window:</span>
          <span className="text-zinc-500">last {INDIETRO_GIORNI} days and next</span>
          {AVANTI_SCELTE.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setAvanti(g)}
              className={`rounded-md px-2 py-1 text-xs ${
                avanti === g
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "border border-zinc-200 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
              }`}
            >
              {g} days
            </button>
          ))}
        </div>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setSopra(true);
        }}
        onDragLeave={() => setSopra(false)}
        onDrop={lascia}
        className={`ui-card flex items-center gap-3 border-2 border-dashed p-4 ${
          sopra
            ? "border-zinc-500 bg-zinc-100 dark:bg-zinc-800"
            : "border-zinc-300 dark:border-zinc-700"
        }`}
      >
        <FileUp className="h-5 w-5 shrink-0 text-zinc-400" />
        {ics ? (
          <>
            <span className="truncate font-mono text-sm text-zinc-700 dark:text-zinc-300">
              {ics.split("/").pop()}
            </span>
            <button
              type="button"
              onClick={() => setIcs(null)}
              className="ml-auto rounded-md p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              title="Remove"
            >
              <X className="h-4 w-4" />
            </button>
          </>
        ) : (
          <p className="text-sm text-zinc-500">
            Or drop an <b>.ics</b> file here — exported from any calendar app.
            Works without any system permission, on every platform.
          </p>
        )}
      </div>

      {/* ⚠️ L'anteprima non e' un vezzo: e' il solo modo di accorgersi di aver
          scelto il calendario sbagliato **prima** che finisca sul dispositivo,
          e di vedere come diventano i titoli dopo la conversione dei
          caratteri che il display non ha. */}
      {anteprima?.ok && (
        <div className="ui-card p-5">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-500">
            What will be sent
          </h3>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            {anteprima.origine} events → {anteprima.eventi} entries,{" "}
            {byte(anteprima.byte)}
            {anteprima.eventi !== anteprima.origine && (
              <span className="text-zinc-500">
                {" "}
                (events crossing midnight are split per day)
              </span>
            )}
          </p>
          {anteprima.troncati && (
            <p className="mt-2 flex items-center gap-2 text-sm text-amber-600">
              <AlertTriangle className="h-4 w-4" />
              Over 2000 entries: the rest is cut. Pick a shorter window.
            </p>
          )}
          {anteprima.esempi.length > 0 && (
            <ul className="mt-3 space-y-0.5 font-mono text-xs text-zinc-600 dark:text-zinc-400">
              {anteprima.esempi.map((e, i) => (
                <li key={i} className="truncate">
                  {e}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-zinc-500">
            Only title, time, place and calendar name leave your Mac. No
            attendees, no notes, no invitations. The file on the card is not
            encrypted: whoever holds the card can read your appointments.
          </p>
        </div>
      )}

      <div className="ui-card flex items-center gap-4 p-5">
        <button
          type="button"
          onClick={() => void manda()}
          disabled={occupato || !device || (!ics && scelti.length === 0)}
          className="flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          <HardDriveDownload className="h-4 w-4" />
          Write to device
        </button>
        <button
          type="button"
          onClick={() => void mandaBle()}
          disabled={occupato || (!ics && scelti.length === 0)}
          className="flex items-center gap-2 rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-200"
        >
          <Bluetooth className="h-4 w-4" />
          Send over Bluetooth
        </button>
        <p className="text-sm text-zinc-500">
          {device
            ? `${device.label} — ${device.mountPath}`
            : "No USB device: Bluetooth works without the cable."}
        </p>
        {esito && (
          <p className="ml-auto flex items-center gap-1.5 text-sm text-zinc-700 dark:text-zinc-300">
            <Check className="h-4 w-4 text-emerald-500" />
            {esito}
          </p>
        )}
      </div>
    </div>
  );
};

export default CalendarPage;
