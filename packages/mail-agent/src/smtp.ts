/**
 * Sends one prepared message over SMTP with AUTH PLAIN: implicit TLS on 465, STARTTLS on 587.
 * Used only when the mailbox owner approved sending an IMAP draft.
 */
import { GmailHttpError, MailAuthError } from "./gmail.ts";
import { LineReader, SMTP_PORTS, type SocketOpener } from "./socket.ts";

export interface SmtpTarget { host: string; port: number; username: string; password: string }

async function reply(reader: LineReader): Promise<{ code: number; text: string }> {
  let line = await reader.line();
  const lines = [line];
  while (/^\d{3}-/.test(line)) { line = await reader.line(); lines.push(line); }
  return { code: Number(line.slice(0, 3)), text: lines.join("\n") };
}

/** Dot-stuffs the message and normalizes line endings to CRLF. */
export function smtpData(mime: string): string {
  return mime.replace(/\r?\n/g, "\r\n").split("\r\n").map((l) => (l.startsWith(".") ? `.${l}` : l)).join("\r\n") + "\r\n.\r\n";
}

const address = /^[^\s<>@]+@[^\s<>@]+$/;

export async function smtpSend(open: SocketOpener, target: SmtpTarget, from: string, recipients: string[], mime: string): Promise<void> {
  if (!SMTP_PORTS.includes(target.port)) throw new Error("This mail server is not allowed");
  if (!address.test(from) || !recipients.length || recipients.some((r) => !address.test(r))) throw new Error("Recipients must be valid email addresses");
  let socket = await open(target.host, target.port, target.port === 465 ? "on" : "starttls");
  const reader = new LineReader(socket);
  const expect = async (ok: (code: number) => boolean, what: string) => {
    const r = await reply(reader);
    if (!ok(r.code)) {
      if (r.code === 535 || r.code === 534) throw new MailAuthError("The mail server refused the password. Connect this mailbox again with a new app password.");
      // 4xx is temporary and nothing was sent; 5xx is a definite refusal. Both mean "not sent".
      throw new GmailHttpError(r.code >= 500 ? 400 : 429);
    }
    return r;
  };
  const send = (line: string) => socket.write(`${line}\r\n`);
  try {
    await expect((c) => c === 220, "greeting");
    await send("EHLO mail-assistant");
    await expect((c) => c === 250, "ehlo");
    if (target.port === 587) {
      await send("STARTTLS");
      await expect((c) => c === 220, "starttls");
      socket = socket.startTls();
      reader.use(socket);
      await send("EHLO mail-assistant");
      await expect((c) => c === 250, "ehlo");
    }
    await send(`AUTH PLAIN ${Buffer.from(`\0${target.username}\0${target.password}`, "utf8").toString("base64")}`);
    await expect((c) => c === 235, "auth");
    await send(`MAIL FROM:<${from}>`);
    await expect((c) => c === 250, "from");
    for (const to of recipients) { await send(`RCPT TO:<${to}>`); await expect((c) => c === 250 || c === 251, "rcpt"); }
    await send("DATA");
    await expect((c) => c === 354, "data");
    await socket.write(smtpData(mime));
    // From here a lost answer means the message may have gone: the caller reports "uncertain".
    const done = await reply(reader).catch(() => { throw new Error("The mail server did not confirm sending"); });
    if (done.code !== 250) throw new GmailHttpError(done.code >= 500 ? 400 : 429);
    await send("QUIT").catch(() => undefined);
  } finally {
    await socket.close();
  }
}
