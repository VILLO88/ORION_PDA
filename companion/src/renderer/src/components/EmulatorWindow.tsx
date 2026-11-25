/**
 * A window with the ORION emulator (WebAssembly, see lib/emulatore.ts):
 * "Try" in the App Store, testing a pending version, and capturing
 * screenshots while publishing.
 *
 * Esc belongs to the app (it is a device key), so the window closes only
 * from its button.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, RotateCcw, Terminal, X } from "lucide-react";
import type { StoreTryPackage } from "@shared/ipc-types";
import { EMU_H, EMU_W, Emulatore } from "@/lib/emulatore";

interface Props {
  title: string;
  /** Where the app comes from: the store, or the author's disk. Called again on Restart. */
  load: () => Promise<StoreTryPackage>;
  /** Present while publishing: "Capture" adds the screen to the screenshots. */
  onCapture?: (pngDataUrl: string) => Promise<void>;
  onClose: () => void;
}

const TASTI = [
  { nome: "MENU", label: "MENU", key: "F1" },
  { nome: "SAVE", label: "SAVE", key: "F2" },
  { nome: "SEARCH", label: "SEARCH", key: "F3" },
  { nome: "PLAY", label: "PLAY", key: "F4" },
  { nome: "ESC", label: "ESC", key: "Esc" },
];

const EmulatorWindow = ({ title, load, onCapture, onClose }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const emu = useRef<Emulatore | null>(null);
  const [stato, setStato] = useState("Loading the emulator…");
  const [log, setLog] = useState<{ t: string; err: boolean }[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [finita, setFinita] = useState(false);
  const [frames, setFrames] = useState(0);
  const [flash, setFlash] = useState("");

  const avvia = useCallback(async () => {
    const e = emu.current;
    if (!e) return;
    setFinita(false);
    setStato("Starting…");
    try {
      const pkg = await load();
      setLog([]);
      await e.avvia(pkg);
      setStato("");
    } catch (err) {
      setStato(`Error: ${(err as Error).message}`);
      setShowLog(true);
    }
  }, [load]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const e = new Emulatore(c, (t, err) => {
      setLog((l) => [...l.slice(-300), { t, err }]);
      /* A Lua error is what the author most needs to see. */
      if (err && /error|attempt to|stack traceback/i.test(t)) setShowLog(true);
    });
    e.onFine = () => setFinita(true);
    emu.current = e;
    void avvia();
    const t = window.setInterval(() => setFrames(e.frameInteri()), 500);
    return () => {
      window.clearInterval(t);
      e.distruggi();
      emu.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cattura = async () => {
    if (!emu.current || !onCapture) return;
    try {
      await onCapture(emu.current.cattura(2));
      setFlash("Added to the screenshots");
    } catch (err) {
      setFlash(`Error: ${(err as Error).message}`);
    }
    window.setTimeout(() => setFlash(""), 2000);
    canvasRef.current?.focus();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="flex max-h-full flex-col gap-3 overflow-auto rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl">
        <div className="flex items-center gap-3">
          <p className="font-semibold text-zinc-100">{title}</p>
          <span className="text-xs text-zinc-400">ORION emulator · {frames} full frames</span>
          <span className="ml-auto flex gap-2">
            {onCapture && (
              <button type="button" className="btn-accent" onClick={() => void cattura()} title="Add this screen to the screenshots">
                <Camera className="h-3.5 w-3.5" />
                Capture
              </button>
            )}
            <button type="button" className="btn-ghost" onClick={() => void avvia()} title="Start the app again">
              <RotateCcw className="h-3.5 w-3.5" />
              Restart
            </button>
            <button type="button" className="btn-ghost" onClick={() => setShowLog((v) => !v)} title="Log (orion.sys.log, Lua errors)">
              <Terminal className="h-3.5 w-3.5" />
            </button>
            <button type="button" className="btn-ghost" onClick={onClose} title="Close">
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>

        <div className="relative">
          <canvas
            ref={canvasRef}
            width={EMU_W}
            height={EMU_H}
            style={{ width: EMU_W * 2, height: EMU_H * 2, imageRendering: "pixelated" }}
            className="block rounded outline-none ring-accent focus:ring-2"
          />
          {(stato || finita || flash) && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="rounded bg-black/75 px-3 py-1.5 text-sm text-white">
                {flash || (finita ? "The app closed. Restart to run it again." : stato)}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          {TASTI.map((t) => (
            <button
              key={t.nome}
              type="button"
              className="rounded border border-zinc-700 px-2 py-1 font-mono text-zinc-200 hover:bg-zinc-800"
              onMouseDown={() => emu.current?.premi(t.nome, true)}
              onMouseUp={() => emu.current?.premi(t.nome, false)}
              onMouseLeave={() => emu.current?.premi(t.nome, false)}
              title={`Keyboard: ${t.key}`}
            >
              {t.label}
            </button>
          ))}
          <span className="ml-2">
            Click the screen, then use the keyboard: arrows, Enter, Backspace · F1 MENU · F2 SAVE · F3 SEARCH · F4 PLAY · Alt = Fn
          </span>
        </div>
        <p className="text-[11px] text-zinc-500">
          Same code as the device, not the same speed: on ORION a full frame takes ~75 ms. Expansion port, Bluetooth, mesh radio
          and microphone are not emulated. What the app saves is lost when this window closes.
        </p>

        {showLog && (
          <pre className="max-h-40 overflow-auto rounded bg-black p-2 font-mono text-[11px] leading-snug">
            {log.length === 0 ? (
              <span className="text-zinc-500">No output.</span>
            ) : (
              log.map((l, i) => (
                <div key={i} className={l.err ? "text-red-400" : "text-zinc-300"}>
                  {l.t}
                </div>
              ))
            )}
          </pre>
        )}
      </div>
    </div>
  );
};

export default EmulatorWindow;
