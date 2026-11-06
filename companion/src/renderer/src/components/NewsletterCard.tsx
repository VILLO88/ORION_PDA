import React, { useEffect, useRef, useState, type FC } from "react";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";

/**
 * Card che embedda la newsletter remota del progetto Orion. Usa il tag
 * <webview> di Electron (NON un <iframe>) così possiamo:
 *
 *   - settare zoom factor lato Chromium per far stare la pagina larga 800-1200 px
 *     nello spazio della colonna (~300 px) senza distorcere
 *   - controllare lo scroll del documento remoto via `executeJavaScript`
 *     anche cross-origin (cosa che un <iframe> con webSecurity: true non
 *     permetterebbe)
 *   - bloccare la navigazione fuori dal dominio newsletter (will-navigate)
 *     così click accidentali nella card non portano l'utente altrove
 *
 * Il content viene servito da orionpda.org/companion/newsletter.html — una
 * pagina non linkata pubblicamente, raggiungibile solo conoscendone l'URL.
 */

const NEWSLETTER_URL = "https://orionpda.org/companion/newsletter.html";
/** Zoom Chromium: 1.0 = native, 0.5 = pagina al 50%. Da tunare in base al
 *  layout effettivo della pagina remota. Valori tipici 0.55-0.75 per una
 *  newsletter pensata a ~800 px di larghezza nella colonna ~300 px. */
const NEWSLETTER_ZOOM = 0.6;
/** Cadenza autoscroll: 1 px ogni N ms. 40 ms = 25 px/s, lento e leggibile. */
const SCROLL_INTERVAL_MS = 40;
/** Pausa al raggiungimento del fondo prima di tornare in cima. */
const PAUSE_AT_END_MS = 3000;

interface WebviewLike extends HTMLElement {
  src: string;
  setZoomFactor(factor: number): void;
  executeJavaScript<T = unknown>(code: string): Promise<T>;
  insertCSS(css: string): Promise<string>;
  reload(): void;
  reloadIgnoringCache(): void;
  addEventListener(
    type: "dom-ready" | "did-fail-load" | "will-navigate",
    listener: (e: Event) => void,
  ): void;
  removeEventListener(
    type: "dom-ready" | "did-fail-load" | "will-navigate",
    listener: (e: Event) => void,
  ): void;
}

const NewsletterCard: FC = () => {
  const webviewRef = useRef<WebviewLike | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Setup webview events
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const onDomReady = () => {
      setReady(true);
      setError(null);
      try {
        wv.setZoomFactor(NEWSLETTER_ZOOM);
      } catch {
        // tolerant: alcuni runtime non implementano setZoomFactor pre dom-ready
      }
      // Nasconde le scrollbar dentro la webview (lo scroll è automatico)
      void wv.insertCSS(`
        ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
        html, body { margin: 0; padding: 0; }
      `).catch(() => undefined);
    };
    const onFail = (e: Event) => {
      const ev = e as Event & { errorDescription?: string; errorCode?: number };
      setError(
        ev.errorDescription
          ? `Newsletter load failed (${ev.errorCode ?? "?"}): ${ev.errorDescription}`
          : "Newsletter load failed.",
      );
      setReady(false);
    };
    const onWillNavigate = (e: Event) => {
      // Impedisce navigazione fuori dalla newsletter (click su link interni).
      const ev = e as Event & { url?: string };
      if (ev.url && !ev.url.startsWith(NEWSLETTER_URL)) {
        e.preventDefault();
      }
    };

    wv.addEventListener("dom-ready", onDomReady);
    wv.addEventListener("did-fail-load", onFail);
    wv.addEventListener("will-navigate", onWillNavigate);
    return () => {
      wv.removeEventListener("dom-ready", onDomReady);
      wv.removeEventListener("did-fail-load", onFail);
      wv.removeEventListener("will-navigate", onWillNavigate);
    };
  }, []);

  // Auto-scroll loop quando ready
  useEffect(() => {
    if (!ready) return;
    const wv = webviewRef.current;
    if (!wv) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (stopped) return;
      try {
        const reachedEnd = await wv.executeJavaScript<boolean>(`
          (() => {
            const max = document.documentElement.scrollHeight - window.innerHeight;
            if (max <= 0) return true;
            if (window.scrollY >= max - 1) return true;
            window.scrollBy(0, 1);
            return false;
          })()
        `);
        if (reachedEnd) {
          // Pausa, poi torna in cima e ricomincia
          timer = setTimeout(async () => {
            if (stopped) return;
            await wv.executeJavaScript(`window.scrollTo(0, 0);`).catch(() => undefined);
            timer = setTimeout(tick, SCROLL_INTERVAL_MS);
          }, PAUSE_AT_END_MS);
        } else {
          timer = setTimeout(tick, SCROLL_INTERVAL_MS);
        }
      } catch {
        // webview detached o navigation in corso: stop
      }
    };
    tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [ready]);

  return (
    <div className="ui-card flex h-full flex-col overflow-hidden p-0">
      <div className="flex items-baseline justify-between border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          News
        </h3>
        <a
          href={NEWSLETTER_URL}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-[11px] font-medium text-accent hover:text-accent-hover"
        >
          Open in browser
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      <div className="relative flex-1 bg-white dark:bg-zinc-950">
        {error ? (
          <div className="flex h-full items-start gap-2 p-4 text-xs text-red-700 dark:text-red-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : (
          <>
            {!ready && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 dark:bg-zinc-950/70">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
              </div>
            )}
            {/* Cast a unknown poi a JSX.IntrinsicElements: il tag <webview>
             * non è nel d.ts standard React, lo trattiamo come elemento HTML. */}
            {React.createElement("webview", {
              ref: webviewRef,
              src: NEWSLETTER_URL,
              partition: "persist:newsletter",
              allowpopups: "false",
              style: {
                display: "flex",
                width: "100%",
                height: "100%",
                border: "0",
                background: "transparent",
              },
            })}
          </>
        )}
      </div>
    </div>
  );
};

export default NewsletterCard;
