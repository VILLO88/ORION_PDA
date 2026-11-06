import { useCallback, useEffect, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import type {
  EbookPreviewItem,
  EbookPreviewPage,
  EbookPreviewResponse,
} from "@shared/ipc-types";

/**
 * Canvas che disegna una singola pagina .pdar fedele al firmware Orion:
 *  - 536×336 logical (post ROT_90), Sharp LS032 normally-white.
 *  - status bar 30 px in alto, area testo sotto i margini PAGE_MARGIN_*.
 *  - testo in font monospace (cell 6×8 × scale) — non bitmap font 5×7 esatto
 *    del firmware ma layout/wrap identico (scelti dal reflow lato main).
 *  - immagini blittate 1bpp MSB-first, bit=1 → bianco (LC OFF).
 *
 * Le pagine arrivano già paginate dal main via ebook:preview; il canvas non
 * fa wrap né scelte di layout. Il CSS lo scala 2× per leggibilità.
 */

const TOKEN = {
  TEXT: 1,
  BOLD: 2,
  ITALIC: 3,
  HEADING: 4,
  NEWLINE: 5,
  PARAGRAPH: 6,
  CODE_INLINE: 7,
  CODE_BLOCK: 8,
  IMAGE: 16,
} as const;

const STATUS_BAR_H = 30;
const BG = "#e6ebef";   // grigio chiaro come Sharp normally-white
const FG = "#0a0a0a";

interface EbookPreviewProps {
  preview: EbookPreviewResponse | null;
  pageIdx: number;
  onPageChange: (idx: number) => void;
  loading?: boolean;
  /** Nome libro mostrato in status bar (facoltativo). */
  title?: string;
}

function blitBitmap(
  ctx: CanvasRenderingContext2D,
  pixels: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
): void {
  const rowBytes = Math.ceil(w / 8);
  const img = ctx.createImageData(w, h);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const byte = pixels[py * rowBytes + (px >> 3)] ?? 0;
      const bit = (byte >> (7 - (px & 7))) & 1;
      const lum = bit ? 230 : 10; // 1=chiaro, 0=scuro (coerente con BG/FG)
      const idx = (py * w + px) * 4;
      img.data[idx] = lum;
      img.data[idx + 1] = lum;
      img.data[idx + 2] = lum;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, x, y);
}

function drawPage(
  canvas: HTMLCanvasElement,
  preview: EbookPreviewResponse,
  page: EbookPreviewPage,
  pageIdx: number,
  title: string | undefined,
): void {
  const {
    displayWidth: W,
    displayHeight: H,
    marginLeft,
    marginTop,
    fontAdvanceW,
    fontAdvanceH,
    scale,
    pages,
  } = preview;
  const cw = fontAdvanceW * scale;
  const ch = fontAdvanceH * scale;
  const x0 = marginLeft;
  const y0 = marginTop;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Background
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Status bar (firmware: nero con titolo a sx + indicatori a dx)
  ctx.fillStyle = FG;
  ctx.fillRect(0, 0, W, STATUS_BAR_H);
  ctx.fillStyle = BG;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = `14px ui-monospace, Menlo, Consolas, monospace`;
  const heading = page.chapterTitle ?? title ?? "Ebook";
  ctx.fillText(heading, 8, STATUS_BAR_H / 2);
  ctx.textAlign = "right";
  ctx.fillText(`${pageIdx + 1} / ${pages.length}`, W - 8, STATUS_BAR_H / 2);

  // Footer hint (riga sottile in basso, mimic del firmware reader)
  ctx.fillStyle = "#9aa3ad";
  ctx.fillRect(0, H - 1, W, 1);

  // Testo
  ctx.fillStyle = FG;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  let col = 0;
  let row = 0;

  const setFont = (item: EbookPreviewItem): void => {
    let weight = "";
    let style = "";
    let family = "ui-monospace, Menlo, Consolas, monospace";
    if (item.t === TOKEN.BOLD) weight = "bold ";
    else if (item.t === TOKEN.ITALIC) style = "italic ";
    else if (item.t === TOKEN.HEADING) weight = "bold ";
    else if (item.t === TOKEN.CODE_INLINE || item.t === TOKEN.CODE_BLOCK) {
      family = "ui-monospace, Menlo, Consolas, monospace";
    }
    ctx.font = `${style}${weight}${ch}px ${family}`;
  };

  const drawChars = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      const x = x0 + col * cw;
      const y = y0 + row * ch;
      // Centra il glyph nella cella per compensare la differenza di metriche
      // tra il font CSS e il bitmap firmware 5×7.
      ctx.fillText(s[i], x, y);
      col++;
    }
  };

  for (const it of page.items) {
    switch (it.t) {
      case TOKEN.TEXT:
      case TOKEN.BOLD:
      case TOKEN.ITALIC:
      case TOKEN.CODE_INLINE:
        setFont(it);
        drawChars(it.s);
        break;
      case TOKEN.HEADING: {
        if (col > 0) {
          row++;
          col = 0;
        }
        setFont(it);
        drawChars(it.s);
        // Underline come hint visivo di heading
        const lineY = y0 + row * ch + ch - 2;
        ctx.fillRect(x0, lineY, col * cw, 1);
        row++;
        col = 0;
        break;
      }
      case TOKEN.NEWLINE:
        row++;
        col = 0;
        break;
      case TOKEN.PARAGRAPH:
        row += 2;
        col = 0;
        break;
      case TOKEN.CODE_BLOCK:
        if (col > 0) {
          row++;
          col = 0;
        }
        setFont(it);
        // Sfondo grigio leggero a tutta riga
        ctx.save();
        ctx.fillStyle = "#cfd6dc";
        ctx.fillRect(x0 - 2, y0 + row * ch, (preview.cols + 1) * cw, ch);
        ctx.restore();
        drawChars(it.s);
        row++;
        col = 0;
        break;
      case TOKEN.IMAGE: {
        if (col > 0) {
          row++;
          col = 0;
        }
        const xCenter = Math.floor((W - it.width) / 2);
        const y = y0 + row * ch;
        blitBitmap(ctx, it.pixels, it.width, it.height, xCenter, y);
        row += Math.ceil(it.height / ch);
        col = 0;
        break;
      }
    }
  }
}

export const EbookPreview = ({
  preview,
  pageIdx,
  onPageChange,
  loading,
  title,
}: EbookPreviewProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const page = useMemo(
    () => (preview ? preview.pages[pageIdx] : null),
    [preview, pageIdx],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !preview || !page) return;
    drawPage(canvas, preview, page, pageIdx, title);
  }, [preview, page, pageIdx, title]);

  const goPrev = useCallback(() => {
    if (!preview) return;
    onPageChange(Math.max(0, pageIdx - 1));
  }, [preview, pageIdx, onPageChange]);

  const goNext = useCallback(() => {
    if (!preview) return;
    onPageChange(Math.min(preview.pages.length - 1, pageIdx + 1));
  }, [preview, pageIdx, onPageChange]);

  // Frecce ← → e PageUp/Down per navigare quando il canvas è in vista
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!preview) return;
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        goPrev();
        e.preventDefault();
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        goNext();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, goPrev, goNext]);

  const W = preview?.displayWidth ?? 536;
  const H = preview?.displayHeight ?? 336;

  return (
    <div className="ui-card flex flex-col gap-3 p-4">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
          Preview
        </h3>
        <span className="text-[11px] text-zinc-500">
          {W}×{H} px · scale {preview?.scale ?? "—"}× ·{" "}
          {preview ? `${preview.cols}×${preview.rows} char` : "—"}
        </span>
      </div>

      <div className="flex items-center justify-center overflow-auto rounded-lg bg-zinc-100 p-3 dark:bg-zinc-950">
        {loading ? (
          <div className="flex items-center gap-2 py-12 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reflowing…
          </div>
        ) : preview && page ? (
          <canvas
            ref={canvasRef}
            width={W}
            height={H}
            style={{
              width: `${W}px`,
              height: `${H}px`,
              imageRendering: "pixelated",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.1)",
            }}
          />
        ) : (
          <div className="py-12 text-sm text-zinc-500">
            Select a file above to see the preview.
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={goPrev}
          disabled={!preview || pageIdx === 0}
          className="btn-ghost disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" />
          Prev
        </button>
        <span className="text-xs text-zinc-500">
          {preview ? `Page ${pageIdx + 1} of ${preview.pages.length}` : "—"}
        </span>
        <button
          type="button"
          onClick={goNext}
          disabled={!preview || pageIdx >= preview.pages.length - 1}
          className="btn-ghost disabled:opacity-40"
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

export default EbookPreview;
