import { useEffect, useState, type ChangeEvent } from "react";
import { AlertTriangle, CheckCircle2, FolderOpen, Globe, X } from "lucide-react";
import { useDevices } from "@/lib/DeviceContext";
import { useActivity } from "@/lib/ActivityContext";
import { api } from "@/lib/api";
import type { WikiConvertResponse, WikiInfoResponse, WikiProgressEvent } from "@shared/ipc-types";

/* Wikipedia for ORION: a Kiwix ZIM -> the ORION Wiki format, read on the
   device by the wiki.lua app. The converter is src/main/wiki; the format,
   and why it is built that way, is FORMATO.md in the SDK. */

const KIWIX = "https://download.kiwix.org/zim/wikipedia/";

const SUGGERITI: { nome: string; cosa: string }[] = [
  { nome: "wikipedia_<lang>_top_mini", cosa: "the most read articles, introduction only (Italian: 114 MB)" },
  { nome: "wikipedia_<lang>_top_nopic", cosa: "the same articles, whole (Italian: 898 MB)" },
  { nome: "wikipedia_<lang>_all_mini", cosa: "every article, introduction only (Italian: 2.3 GB)" },
  { nome: "wikipedia_<lang>_all_nopic", cosa: "everything, without pictures (Italian: 8.4 GB)" },
];

const FASI: Record<WikiProgressEvent["fase"], string> = {
  elenco: "Listing articles",
  testo: "Converting the text",
  indici: "Writing the indexes",
  fatto: "Done",
};

function mb(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`;
}

/** "wikipedia_it_top_mini_2026-10.zim" -> "it_top_mini". */
function nomeDa(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "wiki";
  return base.replace(/\.zim$/i, "").replace(/^wikipedia_/, "").replace(/_\d{4}-\d{2}$/, "") || "wiki";
}

const WikiPage = () => {
  const { devices } = useDevices();
  const device = devices[0] ?? null;
  const { log: logActivity } = useActivity();

  const [zim, setZim] = useState("");
  const [info, setInfo] = useState<WikiInfoResponse | null>(null);
  const [errore, setErrore] = useState("");
  const [target, setTarget] = useState<"device" | "local">(device ? "device" : "local");
  const [localOutDir, setLocalOutDir] = useState("");
  const [nome, setNome] = useState("");
  const [libero, setLibero] = useState(-1);
  const [running, setRunning] = useState(false);
  const [prog, setProg] = useState<WikiProgressEvent | null>(null);
  const [esito, setEsito] = useState<WikiConvertResponse | null>(null);

  useEffect(() => api.wiki.onProgress(setProg), []);

  // free space where the folder would go
  useEffect(() => {
    const dir = target === "device" ? device?.mountPath : localOutDir.trim();
    if (!dir) { setLibero(-1); return; }
    api.wiki.space(dir).then(setLibero).catch(() => setLibero(-1));
  }, [target, device?.mountPath, localOutDir]);

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const p = api.fs.getPathForFile(f);
    setZim(p);
    setInfo(null);
    setEsito(null);
    setErrore("");
    setNome(nomeDa(p));
    try {
      setInfo(await api.wiki.info(p));
    } catch (err) {
      setErrore((err as Error).message);
    }
  };

  const destinazione = target === "device" ? device?.mountPath : localOutDir.trim();
  const pronto = !!info && !!destinazione && nome.trim().length > 0 && !running;
  // The conversion keeps all the text and drops the pictures and markup: a
  // `mini` comes out at ~60% of the ZIM. The ZIM size is a safe ceiling.
  const stretto = info && libero >= 0 && libero < info.dimensione;

  const converti = async () => {
    if (!info || !destinazione) return;
    setRunning(true);
    setEsito(null);
    setErrore("");
    setProg(null);
    try {
      const r = await api.wiki.convert({
        zimPath: zim,
        nome,
        mountPath: target === "device" ? destinazione : undefined,
        localOutDir: target === "local" ? destinazione : undefined,
      });
      setEsito(r);
      logActivity({
        kind: "wiki-convert",
        status: "ok",
        title: `Wikipedia ready: ${info.titolo || nome}`,
        detail: `${r.articoli} articles, ${mb(r.byte)}`,
      });
    } catch (err) {
      const msg = (err as Error).message;
      setErrore(msg === "annullato" ? "Cancelled." : msg);
      if (msg !== "annullato") {
        logActivity({ kind: "wiki-convert", status: "error", title: "Wikipedia failed", detail: msg });
      }
    } finally {
      setRunning(false);
    }
  };

  const percent = prog && prog.totale > 0 ? Math.floor((100 * prog.fatti) / prog.totale) : 0;
  const boxCls = "ui-card p-4";
  const tabCls = (on: boolean) =>
    `px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
      on ? "bg-accent text-white" : "bg-white text-zinc-700 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
    }`;

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Wikipedia on ORION, without a network. A Kiwix <strong>.zim</strong> becomes a folder the{" "}
        <code>wiki</code> app reads a piece at a time: text cleaned up for the 1-bit display, links you can
        follow, search as you type, and the coordinates for looking up the place you are in.
      </p>
      {/* Said up front, not after a conversion of many minutes. */}
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
        Needs ORION firmware 0.3.0 (file seek), coming soon. You can convert now and copy the folder; the{" "}
        <code>wiki</code> app opens it once ORION is updated.
      </p>

      <div className={boxCls}>
        <div className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-100">1. Get a ZIM</div>
        <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
          From{" "}
          <a href={KIWIX} target="_blank" rel="noreferrer" className="text-accent underline">
            download.kiwix.org/zim/wikipedia
          </a>
          , in your language. Pictures are not used: take a <code>mini</code> or a <code>nopic</code>.
        </p>
        <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-300">
          {SUGGERITI.map((s) => (
            <li key={s.nome}>
              <code>{s.nome}</code> — {s.cosa}
            </li>
          ))}
        </ul>
      </div>

      <div className={boxCls}>
        <div className="mb-3 flex items-center gap-3">
          <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">2. Choose it</div>
          <label className="btn-ghost cursor-pointer">
            Choose a .zim
            <input type="file" accept=".zim" onChange={onPick} className="hidden" disabled={running} />
          </label>
        </div>
        {info && (
          <div className="flex items-start gap-3 text-sm">
            <Globe className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
            <div>
              <div className="font-medium text-zinc-900 dark:text-zinc-100">{info.titolo || nomeDa(zim)}</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                {info.descrizione && <>{info.descrizione} · </>}
                {info.lingua} · {info.data} · {info.articoli.toLocaleString()} articles · {mb(info.dimensione)}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={boxCls}>
        <div className="mb-3 text-sm font-semibold text-zinc-800 dark:text-zinc-100">3. Where it goes</div>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
            <button type="button" onClick={() => setTarget("device")} disabled={running || !device} className={tabCls(target === "device")}>
              ORION card {!device && "(none)"}
            </button>
            <button type="button" onClick={() => setTarget("local")} disabled={running} className={tabCls(target === "local")}>
              Folder
            </button>
          </div>
          {target === "local" && (
            <div className="flex items-stretch gap-1">
              <input
                type="text"
                value={localOutDir}
                onChange={(e) => setLocalOutDir(e.target.value)}
                disabled={running}
                placeholder="a folder, copied later to wiki/ on the card"
                className="min-w-[18rem] rounded-l-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <button
                type="button"
                onClick={async () => { const d = await api.fs.chooseDirectory(); if (d) setLocalOutDir(d); }}
                disabled={running}
                className="flex items-center gap-1 rounded-r-lg border border-l-0 border-zinc-200 bg-white px-3 text-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
              >
                <FolderOpen className="h-4 w-4" /> Browse
              </button>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Folder name</label>
            <input
              type="text"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              disabled={running}
              className="w-40 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          {target === "device" ? <>On the card: <code>wiki/{nome || "…"}</code>.</> : <>Copy it to <code>wiki/</code> on the card with a card reader: through ORION's USB it takes about an hour per few GB.</>}
          {libero >= 0 && <> Free: {mb(libero)}.</>}
          {" "}The card must be FAT32.
        </p>
        {stretto && (
          <p className="mt-1 flex items-center gap-1 text-xs text-amber-600">
            <AlertTriangle className="h-3.5 w-3.5" /> Less free space than the ZIM's size: it may not fit.
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button type="button" onClick={converti} disabled={!pronto} className="btn-accent">
          Convert
        </button>
        {running && (
          <button type="button" onClick={() => api.wiki.cancel()} className="btn-ghost flex items-center gap-1">
            <X className="h-4 w-4" /> Cancel
          </button>
        )}
        {running && prog && (
          <div className="flex min-w-[16rem] flex-1 items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
            </div>
            <span className="text-xs text-zinc-500">{FASI[prog.fase]} {prog.totale > 1 ? `${percent}%` : ""}</span>
          </div>
        )}
      </div>

      {errore && (
        <p className="flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="h-4 w-4" /> {errore}
        </p>
      )}
      {esito && (
        <div className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-green-600" />
          <div>
            {esito.articoli.toLocaleString()} articles, {esito.titoli.toLocaleString()} titles,{" "}
            {esito.geo.toLocaleString()} with coordinates, {mb(esito.byte)} in {esito.secondi.toFixed(0)} s.
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              In <code>{esito.outputPath}</code>. On ORION it needs the <code>wiki</code> app and firmware with
              API 0.3.0 (file seek).
            </div>
          </div>
        </div>
      )}
      <p className="text-[11px] text-zinc-400">Text from Wikipedia, CC BY-SA 4.0.</p>
    </div>
  );
};

export default WikiPage;
