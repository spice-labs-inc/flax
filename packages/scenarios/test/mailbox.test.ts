import { describe, expect, it } from "vitest";
import {
  awaitLink,
  awaitMessage,
  findLink,
  plusAddress,
  type MailClient,
  type Mailbox,
} from "../src/mailbox.ts";

const MAILBOX: Mailbox = {
  host: "imap.example.com",
  user: "checks@example.com",
  password: "app-password",
};
const TO = "checks+run-7@example.com";
const SINCE = new Date("2026-03-02T10:00:00Z");
const LINK = /https:\/\/app\.example\.com\/login\?[^\s"'<>]+/;

interface Stored {
  to: string;
  arrived: Date;
  source: string;
}

function email(o: {
  subject: string;
  text?: string;
  html?: string;
  to?: string;
}): string {
  const head = [
    "From: Notes <no-reply@example.com>",
    `To: ${o.to ?? TO}`,
    `Subject: ${o.subject}`,
    "Date: Mon, 02 Mar 2026 10:01:00 +0000",
    "MIME-Version: 1.0",
  ];
  if (o.html === undefined)
    return [
      ...head,
      "Content-Type: text/plain; charset=utf-8",
      "",
      o.text ?? "",
    ].join("\r\n");
  return [
    ...head,
    'Content-Type: multipart/alternative; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.text ?? "",
    "--b",
    "Content-Type: text/html; charset=utf-8",
    "",
    o.html,
    "--b--",
    "",
  ].join("\r\n");
}

/** A mailbox of folders, behaving as the MailClient contract says; `later` arrives on the given poll. */
function fakeServer(
  folders: Record<string, Stored[]>,
  later: { poll: number; folder: string; message: Stored }[] = [],
) {
  let connections = 0;
  let closed = 0;
  const connect = async (mailbox: Mailbox): Promise<MailClient> => {
    expect(mailbox).toBe(MAILBOX);
    connections++;
    for (const l of later)
      if (l.poll === connections) (folders[l.folder] ??= []).push(l.message);
    return {
      async *sources(folder, to, since) {
        for (const m of [...(folders[folder] ?? [])].reverse())
          if (m.to === to && m.arrived >= since) yield Buffer.from(m.source);
      },
      close: async () => void closed++,
    };
  };
  return {
    connect,
    get connections() {
      return connections;
    },
    get closed() {
      return closed;
    },
  };
}

describe("plus addresses", () => {
  it("puts the tag before the last @", () => {
    expect(plusAddress("checks@example.com", "run-7")).toBe(
      "checks+run-7@example.com",
    );
    expect(plusAddress('"a@b"@example.com', "x")).toBe('"a@b"+x@example.com');
  });

  it("refuses something that is not an address", () => {
    expect(() => plusAddress("checks", "x")).toThrow(
      "checks is not an email address",
    );
    expect(() => plusAddress("@example.com", "x")).toThrow();
  });
});

describe("finding a link", () => {
  it("finds it in the text before the HTML", () => {
    expect(
      findLink(
        LINK,
        "Sign in: https://app.example.com/login?token=text\n",
        '<a href="https://app.example.com/login?token=html">Sign in</a>',
      ),
    ).toBe("https://app.example.com/login?token=text");
  });

  it("finds it in the HTML with &amp; undone", () => {
    expect(
      findLink(
        LINK,
        "no link here",
        '<a href="https://app.example.com/login?token=abc&amp;kind=email">Sign in</a>',
      ),
    ).toBe("https://app.example.com/login?token=abc&kind=email");
  });

  it("gives nothing when no link matches, and ignores a global pattern's state", () => {
    expect(findLink(LINK, "https://elsewhere.example.com/login?x=1")).toBe(
      undefined,
    );
    const global = new RegExp(LINK.source, "g");
    expect(findLink(global, "https://app.example.com/login?a=1")).toBe(
      "https://app.example.com/login?a=1",
    );
    expect(findLink(global, "https://app.example.com/login?a=1")).toBe(
      "https://app.example.com/login?a=1",
    );
  });
});

describe("waiting for an email", () => {
  it("returns the newest message to the address, parsed", async () => {
    const server = fakeServer({
      INBOX: [
        {
          to: TO,
          arrived: new Date("2026-03-02T10:01:00Z"),
          source: email({ subject: "Older", text: "first" }),
        },
        {
          to: TO,
          arrived: new Date("2026-03-02T10:02:00Z"),
          source: email({
            subject: "Welcome",
            text: "Hello",
            html: "<p>Hello</p>",
          }),
        },
      ],
    });
    const message = await awaitMessage({
      mailbox: MAILBOX,
      to: TO,
      since: SINCE,
      connect: server.connect,
    });
    expect(message).toEqual({
      folder: "INBOX",
      subject: "Welcome",
      date: new Date("2026-03-02T10:01:00Z"),
      text: "Hello",
      html: "<p>Hello</p>",
    });
    expect(server.closed).toBe(1);
  });

  it("skips messages to other addresses, from before since, and that fail match; searches the folders in order", async () => {
    const lines: string[] = [];
    const server = fakeServer({
      INBOX: [
        {
          to: "checks+other@example.com",
          arrived: new Date("2026-03-02T10:05:00Z"),
          source: email({ subject: "Invite", to: "checks+other@example.com" }),
        },
        {
          to: TO,
          arrived: new Date("2026-03-02T09:00:00Z"),
          source: email({ subject: "Invite" }),
        },
        {
          to: TO,
          arrived: new Date("2026-03-02T10:03:00Z"),
          source: email({ subject: "Receipt" }),
        },
      ],
      Junk: [
        {
          to: TO,
          arrived: new Date("2026-03-02T10:04:00Z"),
          source: email({ subject: "Invite", text: "join" }),
        },
      ],
    });
    const message = await awaitMessage({
      mailbox: MAILBOX,
      to: TO,
      since: SINCE,
      folders: ["INBOX", "Missing", "Junk"],
      match: (m) => m.subject === "Invite",
      log: (line) => lines.push(line),
      connect: server.connect,
    });
    expect(message.folder).toBe("Junk");
    expect(message.text).toBe("join");
    expect(lines).toEqual([`mailbox: found an email to ${TO} in Junk`]);
  });

  it("polls with a fresh connection until the message arrives", async () => {
    const server = fakeServer({ INBOX: [] }, [
      {
        poll: 3,
        folder: "INBOX",
        message: {
          to: TO,
          arrived: new Date("2026-03-02T10:06:00Z"),
          source: email({ subject: "At last" }),
        },
      },
    ]);
    const message = await awaitMessage({
      mailbox: MAILBOX,
      to: TO,
      since: SINCE,
      pollMs: 1,
      connect: server.connect,
    });
    expect(message.subject).toBe("At last");
    expect(server.connections).toBe(3);
    expect(server.closed).toBe(3);
  });

  it("says what never arrived when time runs out", async () => {
    const server = fakeServer({ INBOX: [] });
    await expect(
      awaitMessage({
        mailbox: MAILBOX,
        to: TO,
        since: SINCE,
        folders: ["INBOX", "Spam"],
        timeoutMs: 0,
        connect: server.connect,
      }),
    ).rejects.toThrow(
      `an email to ${TO} arriving did not happen within 0 s (last seen: no match in INBOX, Spam, poll 1)`,
    );
    expect(server.closed).toBe(1);
  });
});

describe("waiting for a link", () => {
  it("returns the first matching link of the first email that has one", async () => {
    const server = fakeServer({
      INBOX: [
        {
          to: TO,
          arrived: new Date("2026-03-02T10:01:00Z"),
          source: email({
            subject: "Sign in",
            text: "Use the button.",
            html: '<a href="https://app.example.com/login?token=abc&amp;kind=email">Sign in</a>',
          }),
        },
        {
          to: TO,
          arrived: new Date("2026-03-02T10:02:00Z"),
          source: email({ subject: "Tips", text: "No links today." }),
        },
      ],
    });
    await expect(
      awaitLink({
        mailbox: MAILBOX,
        to: TO,
        since: SINCE,
        pattern: LINK,
        connect: server.connect,
      }),
    ).resolves.toBe("https://app.example.com/login?token=abc&kind=email");
  });

  it("applies the caller's match too, and names the pattern on a timeout", async () => {
    const server = fakeServer({
      INBOX: [
        {
          to: TO,
          arrived: new Date("2026-03-02T10:01:00Z"),
          source: email({
            subject: "Sign in",
            text: "https://app.example.com/login?token=abc",
          }),
        },
      ],
    });
    await expect(
      awaitLink({
        mailbox: MAILBOX,
        to: TO,
        since: SINCE,
        pattern: LINK,
        match: (m) => m.subject === "Invite",
        timeoutMs: 0,
        connect: server.connect,
      }),
    ).rejects.toThrow(
      `an email to ${TO} with a link matching ${LINK} arriving did not happen`,
    );
  });
});
