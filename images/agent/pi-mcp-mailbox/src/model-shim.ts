import { connect, createServer, type Socket } from "node:net";
import { MODEL_SHIM_HOST } from "./sockets.ts";

/** At most this many connections through the shim at once; Pi opens one or two. */
export const MAX_SHIM_CONNECTIONS = 16;

export interface ModelShim {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * The port in FLAX_AGENTS_MODEL_BASE_URL, which with the model socket mounted must be
 * exactly http://127.0.0.1:<port>: the shim is the only way to the model.
 */
export function shimPort(baseUrl: string | undefined): number {
  const refuse = () =>
    new Error(
      `FLAX_AGENTS_MODEL_BASE_URL is ${JSON.stringify(baseUrl ?? "")}; with the model socket mounted it must be http://${MODEL_SHIM_HOST}:<port>`,
    );
  if (baseUrl === undefined) throw refuse();
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw refuse();
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== MODEL_SHIM_HOST ||
    !Number.isInteger(port) ||
    port < 1 ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.username !== "" ||
    url.password !== ""
  )
    throw refuse();
  return port;
}

/**
 * Listens on the box's loopback interface and passes each connection,
 * byte for byte, to the model socket the runner serves. It reads and
 * changes nothing: what may reach the model is decided by the runner's
 * forwarder on the other end. Its handles do not keep Pi running.
 */
export async function startModelShim(options: {
  socketPath: string;
  port: number;
}): Promise<ModelShim> {
  const open = new Set<Socket>();
  const server = createServer((box) => {
    const runner = connect(options.socketPath);
    for (const s of [box, runner]) {
      s.unref();
      open.add(s);
    }
    const end = () => {
      box.destroy();
      runner.destroy();
      open.delete(box);
      open.delete(runner);
    };
    box.on("error", end).on("close", end);
    runner.on("error", end).on("close", end);
    box.pipe(runner);
    runner.pipe(box);
  });
  server.maxConnections = MAX_SHIM_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, MODEL_SHIM_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        server.close(() => resolve());
      }),
  };
}
