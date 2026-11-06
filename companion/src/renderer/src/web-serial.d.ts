/**
 * I tipi di Web Serial, **solo quelli che usiamo** — per la stessa ragione
 * di `web-bluetooth.d.ts`: poche righe contro una dipendenza, e dicono
 * quanta di quell'API tocchiamo.
 */
interface SerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
}

interface Serial {
  requestPort(options?: { filters?: SerialPortFilter[] }): Promise<SerialPort>;
}

interface Navigator {
  readonly serial?: Serial;
}
