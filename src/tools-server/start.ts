import { closeSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  messageFile,
  parseMessageFile,
  TO_BOX,
  TO_SERVER,
} from "../../images/agent/pi-mcp-mailbox/src/protocol.ts";
import { loadAllowlists } from "../lib/allowlists.ts";
import { toolLimits, type JobConfig, type ToolLimits } from "../lib/job.ts";
import { toolDir, toolFile } from "../lib/paths.ts";
import { firstLine, formatProblem } from "../lib/problem.ts";
import { byCodePoint } from "../lib/sort.ts";
import { loadTool } from "../lib/tools.ts";
import type { ReportWriter } from "../run-job/report.ts";
import { readUntrusted } from "../run-job/untrusted.ts";
import {
  createMailbox,
  MailboxServerTransport,
  openMailbox,
  viaFd,
  type MailboxEvent,
} from "./mailbox.ts";
import { loadMapping } from "./mapping.ts";
import {
  SocketServerTransport,
  type SocketEvent,
  type SocketRecord,
} from "./socket.ts";
import {
  ToolsServer,
  type CallRecord,
  type LoadedTool,
  type MethodRefusal,
} from "./server.ts";
import { DEFAULT_UPSTREAMS, type Upstreams } from "./upstreams.ts";

export interface ToolsReport {
  tools: string[];
  limits: ToolLimits;
  /** Each call, with the text an answered call gave the model inside the data markers. */
  calls: (CallRecord & { result?: string })[];
  refusedMethods: MethodRefusal[];
  /** What the mailbox refused; set for the tools of collect.ts, served over the mailbox. */
  mailbox?: MailboxEvent[];
  /** What the tools socket refused; set for the model's tools, served over the socket. */
  socket?: SocketEvent[];
}

export interface RunningTools {
  server: ToolsServer;
  /** Every message over the tools socket; set when the tools were served over it. */
  socket?: SocketRecord;
  report(): ToolsReport;
  /**
   * Readies the tools socket for another box of the same run, such as the
   * repair turn's: once a box has used the socket, its session is ended and
   * a new one listens on the same path, with the same tools, limits, calls
   * and record. A socket no box has used yet is left as it is.
   */
  nextSession(): Promise<void>;
  stop(): Promise<void>;
}

export interface StartToolsOptions {
  root: string;
  /** For collect.ts, the directory outside the data directory the mailbox is created in; unused with socketPath. */
  dataDir: string;
  /** The model's tools socket; without it the tools are served over a mailbox in dataDir. */
  socketPath?: string;
  job: JobConfig;
  /** The tools to serve; the job's tools when not given. */
  tools?: readonly string[];
  /** The limits on the calls; the job's tool limits when not given. */
  limits?: ToolLimits;
  upstreams?: Upstreams;
  /** Cleans upstream text; startUpstreams() returns one that knows the run's credentials. */
  scrub?: (text: string) => string;
  /** The commit gh-file reads each repository at, by name, for a job with pin_files. */
  commits?: ReadonlyMap<string, string>;
  pollMs?: number;
  now?: () => Date;
}

/** Loads the tools a job lists, exactly as flax agents check accepted them. */
export async function loadJobTools(
  root: string,
  names: readonly string[],
): Promise<LoadedTool[]> {
  const tools: LoadedTool[] = [];
  for (const name of names) {
    let isDir = false;
    try {
      isDir = lstatSync(join(root, toolDir(name))).isDirectory();
    } catch {
      // Reported just below.
    }
    if (!isDir) throw new Error(`${toolDir(name)}/ does not exist`);
    const entry = loadTool(root, name);
    if (entry.spec === undefined)
      throw new Error(
        `${toolDir(name)}/ is not a valid tool: ${entry.problems.map(formatProblem).join("; ")}`,
      );
    try {
      tools.push({ spec: entry.spec, mapping: await loadMapping(root, name) });
    } catch (err) {
      throw new Error(`${toolFile(name, "map.ts")}: ${firstLine(err)}`);
    }
  }
  return tools;
}

/**
 * Listens on the tools socket, or for collect.ts creates its mailbox, and
 * starts the tools server on it, serving the job's tools under the job's
 * limits. The runner starts it before the box (or collect.ts) and stops it
 * after.
 */
export async function startToolsServer(
  options: StartToolsOptions,
): Promise<RunningTools> {
  const tools = await loadJobTools(
    options.root,
    options.tools ?? options.job.tools,
  );
  const limits = options.limits ?? toolLimits(options.job);
  if (options.socketPath === undefined) createMailbox(options.dataDir);
  const events: MailboxEvent[] = [];
  const socketEvents: SocketEvent[] = [];
  const server = new ToolsServer({
    tools,
    limits,
    upstreams: options.upstreams ?? DEFAULT_UPSTREAMS,
    readChannels: loadAllowlists(options.root).allowlists.readChannels,
    ...(options.scrub === undefined ? {} : { scrub: options.scrub }),
    ...(options.commits === undefined ? {} : { commits: options.commits }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  // Each call is one request; the rest covers the handshake, listing and cancellations.
  const maxMessages = limits.calls * 3 + 50;
  const socketPath = options.socketPath;
  const listen = (record?: SocketRecord) =>
    socketPath === undefined
      ? undefined
      : new SocketServerTransport({
          socketPath,
          maxMessages,
          ...(record === undefined ? {} : { record }),
          onEvent: (event) => socketEvents.push(event),
          ...(options.now === undefined ? {} : { now: options.now }),
        });
  let socket = listen();
  await server.connect(
    socket ??
      new MailboxServerTransport({
        dataDir: options.dataDir,
        maxFiles: maxMessages,
        onEvent: (event) => events.push(event),
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
  );
  return {
    server,
    ...(socket === undefined ? {} : { socket: socket.record }),
    nextSession: async () => {
      if (socket === undefined || !socket.used) return;
      await socket.close();
      socket = listen(socket.record)!;
      await server.connect(socket);
    },
    report: () => ({
      tools: tools.map((t) => t.spec.name),
      limits,
      calls: server.calls.map((call) => {
        const answered = server.results.find((r) => r.n === call.n);
        return answered === undefined
          ? call
          : { ...call, result: answered.text };
      }),
      refusedMethods: server.refusedMethods,
      ...(socket === undefined
        ? { mailbox: events }
        : { socket: socketEvents }),
    }),
    stop: () => server.close(),
  };
}

/**
 * Puts the tools record and every message into the run report, for audit.
 * Every message over the tools socket goes into socket/in/ and socket/out/,
 * one file each. The mailbox of collect.ts is opened again one level at a
 * time, refusing links, so a mailbox swapped for a link copies nothing;
 * only message file names are copied, so other names cannot push messages
 * out. Files are read with the untrusted-file rules, and the report writer
 * scrubs secrets from them like every other report file.
 */
export function writeToolsReport(
  report: ReportWriter,
  tools: RunningTools,
  dataDir: string,
  /** Put in front of every report path, such as collect/ for the calls of collect.ts. */
  prefix = "",
): void {
  const record: ToolsReport & { mailboxNotCopied?: string } = tools.report();
  if (tools.socket !== undefined) {
    const maxFiles = record.limits.calls * 3 + 50;
    for (const [dir, lines] of [
      ["in", tools.socket.in],
      ["out", tools.socket.out],
    ] as const)
      lines
        .slice(0, maxFiles)
        .forEach((text, i) =>
          report.write(`${prefix}socket/${dir}/${messageFile(i + 1)}`, text),
        );
    report.writeJson(`${prefix}tools.json`, record);
    return;
  }
  let dirs;
  try {
    dirs = openMailbox(dataDir);
  } catch (err) {
    record.mailboxNotCopied = firstLine(err);
  }
  if (dirs !== undefined) {
    const maxFiles = record.limits.calls * 3 + 50;
    try {
      for (const [dir, fd, maxBytes] of [
        [TO_SERVER, dirs.toServer, MAX_REQUEST_BYTES],
        [TO_BOX, dirs.toBox, MAX_RESPONSE_BYTES],
      ] as const) {
        const names = readdirSync(viaFd(fd))
          .filter((name) => parseMessageFile(name) !== undefined)
          .sort(byCodePoint)
          .slice(0, maxFiles);
        for (const name of names) {
          const file = readUntrusted(viaFd(fd, name), maxBytes, {
            singleLink: true,
          });
          if ("text" in file)
            report.write(`${prefix}mailbox/${dir}/${name}`, file.text);
        }
      }
    } finally {
      closeSync(dirs.toServer);
      closeSync(dirs.toBox);
    }
  }
  report.writeJson(`${prefix}tools.json`, record);
}
