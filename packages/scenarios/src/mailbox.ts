import { waitFor } from "@flax/core/http";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export type Log = (line: string) => void;

/** An IMAP mailbox that a run's emails arrive in. */
export interface Mailbox {
  host: string;
  /** Default 993. */
  port?: number;
  user: string;
  password: string;
  /** TLS from the start; default true. */
  secure?: boolean;
}

/** One email as the poll found it. */
export interface MailMessage {
  folder: string;
  subject: string;
  date: Date | undefined;
  text: string;
  html: string;
}

/** What a poll needs from a connection to the mailbox. */
export interface MailClient {
  /** The raw messages in `folder` addressed to `to` that arrived at or after `since`, newest first; none when there is no such folder. */
  sources(folder: string, to: string, since: Date): AsyncIterable<Buffer>;
  close(): Promise<void>;
}

export interface MailQuery {
  mailbox: Mailbox;
  /** The recipient address, usually a plusAddress of the mailbox's user. */
  to: string;
  /** Only messages that arrived at or after this time. */
  since: Date;
  /** Searched in order; a folder the mailbox lacks is skipped. Default INBOX, Junk, Spam. */
  folders?: readonly string[];
  /** Default 5 minutes. */
  timeoutMs?: number;
  /** Default 5 s. */
  pollMs?: number;
  /** Narrows the messages that count; any message to `to` by default. */
  match?: (message: MailMessage) => boolean;
  log?: Log;
  /** Opens the connection each poll uses; an IMAP client by default. */
  connect?: (mailbox: Mailbox) => Promise<MailClient>;
}

export const DEFAULT_FOLDERS: readonly string[] = ["INBOX", "Junk", "Spam"];

/** A plus address of the mailbox's user for one run: `user+tag@domain`. */
export function plusAddress(user: string, tag: string): string {
  const at = user.lastIndexOf("@");
  if (at <= 0) throw new Error(`${user} is not an email address`);
  return `${user.slice(0, at)}+${tag}${user.slice(at)}`;
}

/** The first match of `pattern` in an email's text, then its HTML, with `&amp;` undone. */
export function findLink(
  pattern: RegExp,
  text: string,
  html = "",
): string | undefined {
  const once = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
  return `${text}\n${html}`.replace(/&amp;/g, "&").match(once)?.[0];
}

/** Polls the mailbox until a message to `to` that arrived after `since` (and passes `match`) is there. */
export function awaitMessage(query: MailQuery): Promise<MailMessage> {
  return poll(query, "an email to the address arriving");
}

/** Polls the mailbox for an email to `to` holding a link that matches `pattern`, and returns the link. */
export async function awaitLink(
  query: MailQuery & { pattern: RegExp },
): Promise<string> {
  const { pattern, match = () => true, ...rest } = query;
  const linkIn = (m: MailMessage) => findLink(pattern, m.text, m.html);
  const message = await poll(
    { ...rest, match: (m) => match(m) && linkIn(m) !== undefined },
    `an email to the address with a link matching ${pattern} arriving`,
  );
  return linkIn(message)!;
}

async function poll(query: MailQuery, what: string): Promise<MailMessage> {
  const {
    mailbox,
    to,
    since,
    folders = DEFAULT_FOLDERS,
    timeoutMs = 300_000,
    pollMs = 5_000,
    match = () => true,
    log = () => {},
    connect = connectImap,
  } = query;
  let polls = 0;
  return waitFor(
    what,
    timeoutMs,
    async () => {
      const client = await connect(mailbox);
      try {
        for (const folder of folders)
          for await (const source of client.sources(folder, to, since)) {
            const message = await parse(folder, source);
            if (match(message)) {
              log(`mailbox: found the email in ${folder}`);
              return { value: message, state: `found in ${folder}` };
            }
          }
      } finally {
        await client.close().catch(() => undefined);
      }
      if (++polls % 6 === 0) log("mailbox: still waiting for the email");
      return { state: `no match in ${folders.join(", ")}, poll ${polls}` };
    },
    pollMs,
  );
}

async function parse(folder: string, source: Buffer): Promise<MailMessage> {
  const parsed = await simpleParser(source);
  return {
    folder,
    subject: parsed.subject ?? "",
    date: parsed.date,
    text: parsed.text ?? "",
    html: typeof parsed.html === "string" ? parsed.html : "",
  };
}

/** An IMAP connection to the mailbox. */
export async function connectImap(mailbox: Mailbox): Promise<MailClient> {
  const client = new ImapFlow({
    host: mailbox.host,
    port: mailbox.port ?? 993,
    secure: mailbox.secure ?? true,
    auth: { user: mailbox.user, pass: mailbox.password },
    logger: false,
  });
  await client.connect();
  return {
    async *sources(folder, to, since) {
      let lock;
      try {
        lock = await client.getMailboxLock(folder);
      } catch {
        return;
      }
      try {
        // IMAP SINCE is a date in the mailbox's own time zone and date-granular, so
        // search from a day earlier and let the exact arrival time decide.
        const uids = await client.search(
          { since: new Date(since.getTime() - 24 * 3600_000), to },
          { uid: true },
        );
        for (const uid of (uids || []).slice(-25).reverse()) {
          const msg = await client.fetchOne(
            String(uid),
            { source: true, internalDate: true },
            { uid: true },
          );
          if (!msg || !msg.source) continue;
          if (msg.internalDate && new Date(msg.internalDate) < since) continue;
          yield msg.source;
        }
      } finally {
        lock.release();
      }
    },
    close: () => client.logout(),
  };
}
