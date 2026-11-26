/**
 * Outgoing TCP for IMAP and SMTP. On Cloudflare Workers this uses `cloudflare:sockets`; tests inject a
 * fake. Only public mail ports are allowed and host names are checked, so a user-entered server can
 * never point the platform at an internal address.
 */
export interface MailSocket {
  write(data: Uint8Array | string): Promise<void>;
  /** Next chunk of bytes, or null when the server closed the connection. */
  read(): Promise<Uint8Array | null>;
  /** Upgrades a plain connection opened with `tls: "starttls"` (SMTP on port 587). */
  startTls(): MailSocket;
  close(): Promise<void>;
}
export type SocketOpener = (host: string, port: number, tls: "on" | "starttls") => Promise<MailSocket>;

export const IMAP_PORTS = [993];
export const SMTP_PORTS = [465, 587];

/** A public DNS name: no IP literals, no single-label or internal names. */
export function validMailHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h.length > 253 || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) return false;
  return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(h);
}

interface CfSocket {
  readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; closed: Promise<void>;
  startTls(): CfSocket; close(): Promise<void>;
}

function wrap(socket: CfSocket): MailSocket {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const encoder = new TextEncoder();
  return {
    async write(data) { await writer.write(typeof data === "string" ? encoder.encode(data) : data); },
    async read() { const { value, done } = await reader.read(); return done ? null : value ?? new Uint8Array(); },
    startTls() { reader.releaseLock(); writer.releaseLock(); return wrap(socket.startTls()); },
    async close() { try { await socket.close(); } catch { /* already closed */ } },
  };
}

export const cloudflareSockets: SocketOpener = async (host, port, tls) => {
  if (!validMailHost(host) || ![...IMAP_PORTS, ...SMTP_PORTS].includes(port)) throw new Error("This mail server is not allowed");
  let mod: { connect(address: { hostname: string; port: number }, options: { secureTransport: string; allowHalfOpen: boolean }): CfSocket };
  try {
    mod = await import(/* webpackIgnore: true */ "cloudflare:sockets" as string);
  } catch {
    throw new Error("IMAP mailboxes need the Cloudflare runtime");
  }
  return wrap(mod.connect({ hostname: host, port }, { secureTransport: tls, allowHalfOpen: false }));
};

const decoder = new TextDecoder("latin1");

/** Buffered, binary-safe reading of lines and fixed-size literals, with a time limit per read. */
export class LineReader {
  private buffer = new Uint8Array(0);
  private socket: MailSocket;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(socket: MailSocket, timeoutMs = 20_000, maxBytes = 40 * 1024 * 1024) {
    this.socket = socket; this.timeoutMs = timeoutMs; this.maxBytes = maxBytes;
  }

  use(socket: MailSocket) { this.socket = socket; this.buffer = new Uint8Array(0); }

  private async fill(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      this.socket.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("The mail server did not answer in time")), this.timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    if (chunk === null) throw new Error("The mail server closed the connection");
    if (this.buffer.length + chunk.length > this.maxBytes) throw new Error("The mail server sent too much data");
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer); next.set(chunk, this.buffer.length);
    this.buffer = next;
  }

  async line(): Promise<string> {
    for (;;) {
      const i = this.buffer.indexOf(10);
      if (i >= 0) {
        const text = decoder.decode(this.buffer.subarray(0, i > 0 && this.buffer[i - 1] === 13 ? i - 1 : i));
        this.buffer = this.buffer.subarray(i + 1);
        return text;
      }
      await this.fill();
    }
  }

  async bytes(n: number): Promise<Uint8Array> {
    while (this.buffer.length < n) await this.fill();
    const out = this.buffer.slice(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }
}
