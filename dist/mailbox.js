import { waitFor } from "@flax/core/http";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
export const DEFAULT_FOLDERS = ["INBOX", "Junk", "Spam"];
/** A plus address of the mailbox's user for one run: `user+tag@domain`. */
export function plusAddress(user, tag) {
    const at = user.lastIndexOf("@");
    if (at <= 0)
        throw new Error(`${user} is not an email address`);
    return `${user.slice(0, at)}+${tag}${user.slice(at)}`;
}
/** The first match of `pattern` in an email's text, then its HTML, with `&amp;` undone. */
export function findLink(pattern, text, html = "") {
    const once = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
    return `${text}\n${html}`.replace(/&amp;/g, "&").match(once)?.[0];
}
/** Polls the mailbox until a message to `to` that arrived after `since` (and passes `match`) is there. */
export function awaitMessage(query) {
    return poll(query, `an email to ${query.to} arriving`);
}
/** Polls the mailbox for an email to `to` holding a link that matches `pattern`, and returns the link. */
export async function awaitLink(query) {
    const { pattern, match = () => true, ...rest } = query;
    const linkIn = (m) => findLink(pattern, m.text, m.html);
    const message = await poll({ ...rest, match: (m) => match(m) && linkIn(m) !== undefined }, `an email to ${query.to} with a link matching ${pattern} arriving`);
    return linkIn(message);
}
async function poll(query, what) {
    const { mailbox, to, since, folders = DEFAULT_FOLDERS, timeoutMs = 300_000, pollMs = 5_000, match = () => true, log = () => { }, connect = connectImap, } = query;
    let polls = 0;
    return waitFor(what, timeoutMs, async () => {
        const client = await connect(mailbox);
        try {
            for (const folder of folders)
                for await (const source of client.sources(folder, to, since)) {
                    const message = await parse(folder, source);
                    if (match(message)) {
                        log(`mailbox: found an email to ${to} in ${folder}`);
                        return { value: message, state: `found in ${folder}` };
                    }
                }
        }
        finally {
            await client.close().catch(() => undefined);
        }
        if (++polls % 6 === 0)
            log(`mailbox: still waiting for an email to ${to}`);
        return { state: `no match in ${folders.join(", ")}, poll ${polls}` };
    }, pollMs);
}
async function parse(folder, source) {
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
export async function connectImap(mailbox) {
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
            }
            catch {
                return;
            }
            try {
                // IMAP SINCE is a date in the mailbox's own time zone and date-granular, so
                // search from a day earlier and let the exact arrival time decide.
                const uids = await client.search({ since: new Date(since.getTime() - 24 * 3600_000), to }, { uid: true });
                for (const uid of (uids || []).slice(-25).reverse()) {
                    const msg = await client.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
                    if (!msg || !msg.source)
                        continue;
                    if (msg.internalDate && new Date(msg.internalDate) < since)
                        continue;
                    yield msg.source;
                }
            }
            finally {
                lock.release();
            }
        },
        close: () => client.logout(),
    };
}
//# sourceMappingURL=mailbox.js.map