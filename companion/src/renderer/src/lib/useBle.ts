import { useEffect, useState } from "react";
import { bleCondiviso } from "./bleOrion";

/** Lo stato della connessione Bluetooth condivisa, per le pagine. */
export function useBle(): {
  connesso: boolean;
  naviga: boolean;
  nome: string;
  liberiKb: number;
} {
  const [, rifai] = useState(0);
  useEffect(() => bleCondiviso.suCambio(() => rifai((n) => n + 1)), []);
  return {
    connesso: bleCondiviso.connesso,
    naviga: bleCondiviso.naviga,
    nome: bleCondiviso.nome || "ORION",
    liberiKb: bleCondiviso.liberiKb,
  };
}

/** Sopra questa soglia un invio via radio chiede conferma. */
export const BLE_FILE_GROSSO = 100 * 1024;

export function formattaByte(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function formattaDurata(secondi: number): string {
  if (secondi < 90) return `about ${Math.max(5, Math.round(secondi / 5) * 5)} seconds`;
  if (secondi < 5400) return `about ${Math.round(secondi / 60)} minutes`;
  return `about ${(secondi / 3600).toFixed(1)} hours`;
}

/**
 * L'avviso prima di un invio grosso. `true` = procedi.
 *
 * ⚠️ Il Bluetooth qui porta qualche centinaio di byte al secondo — fino a
 * ~1,2 kB/s col pacchetto massimo — e non c'è modo di alzarlo (vedi
 * `BLE_DATI.md` §7bis). Sotto la soglia non si chiede niente: una nota non
 * deve costare un clic in più.
 */
export function confermaInvioBle(byte: number, quanti = 1): boolean {
  if (byte <= BLE_FILE_GROSSO) return true;
  const sec = byte / Math.max(100, bleCondiviso.velocitaStimata);
  return window.confirm(
    `${quanti === 1 ? "This file is" : `These ${quanti} files are`} ${formattaByte(byte)}: ` +
      `over Bluetooth that takes ${formattaDurata(sec)}.\n\n` +
      "Bluetooth is meant for small files — the USB cable is far faster.\n\n" +
      "Send anyway?",
  );
}
