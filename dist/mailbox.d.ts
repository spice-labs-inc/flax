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
export declare const DEFAULT_FOLDERS: readonly string[];
/** A plus address of the mailbox's user for one run: `user+tag@domain`. */
export declare function plusAddress(user: string, tag: string): string;
/** The first match of `pattern` in an email's text, then its HTML, with `&amp;` undone. */
export declare function findLink(pattern: RegExp, text: string, html?: string): string | undefined;
/** Polls the mailbox until a message to `to` that arrived after `since` (and passes `match`) is there. */
export declare function awaitMessage(query: MailQuery): Promise<MailMessage>;
/** Polls the mailbox for an email to `to` holding a link that matches `pattern`, and returns the link. */
export declare function awaitLink(query: MailQuery & {
    pattern: RegExp;
}): Promise<string>;
/** An IMAP connection to the mailbox. */
export declare function connectImap(mailbox: Mailbox): Promise<MailClient>;
