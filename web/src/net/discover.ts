// The /discover socket: while a home page is visible to its network, the server lists the other visible
// pages behind the same public address and passes an ask and its answer between two of them. Everything here crosses
// the server in clear and is untrusted on arrival; the room that follows proves itself with a compared code.
import { parseAccessKey } from "../crypto/invite.ts";
import { NAME_MAX, cleanName } from "./device.ts";

/** Another visible device; `id` is the server's random number for its socket. */
export type Found = { id: string; name: string; device: string };

export interface DiscoverHandlers {
  devices(list: Found[]): void;
  /** `from` wants to start a room with this device. */
  asked(from: Found): void;
  /** The device we asked answered: the access key of the room it created, or null when it declined. */
  answered(from: string, room: string | null): void;
}

const RETRY_MS = 5000;
/** The server sends at most its GROUP_MAX (src/discover/lobby.rs). */
const LIST_MAX = 32;

function parseFound(raw: unknown): Found | null {
  const fields = (raw ?? {}) as Partial<Record<keyof Found, unknown>>;
  const name = cleanName(fields.name);
  const device = cleanName(fields.device);

  return typeof fields.id === "string" && fields.id.length <= NAME_MAX && name && device
    ? { id: fields.id, name, device }
    : null;
}

export class Discover {
  private socket!: WebSocket;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private list: Found[] = [];

  constructor(
    private readonly name: string,
    private readonly device: string,
    private readonly on: DiscoverHandlers,
  ) {
    this.open();
  }

  public ask(to: string): void {
    this.send({ t: "ask", to });
  }

  public answer(to: string, room: string | null): void {
    this.send({ t: "answer", to, ...(room !== null && { room }) });
  }

  public close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.socket.close();
  }

  private send(message: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private open(): void {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/discover`);
    this.socket = socket;

    socket.onopen = () => this.send({ t: "hello", name: this.name, device: this.device });
    socket.onmessage = (event) => {
      if (this.closed || typeof event.data !== "string") return;

      try {
        this.onText(JSON.parse(event.data) as Record<string, unknown>);
      } catch {}
    };
    socket.onclose = () => {
      if (this.closed) return;

      this.list = [];
      this.on.devices([]);
      this.retry = setTimeout(() => this.open(), RETRY_MS);
    };
  }

  private onText(message: Record<string, unknown>): void {
    if (message.t === "devices" && Array.isArray(message.devices)) {
      this.list = message.devices
        .slice(0, LIST_MAX)
        .map(parseFound)
        .filter((found) => found !== null);
      this.on.devices(this.list);

      return;
    }

    // Only a device the server listed can ask or answer.
    const from = this.list.find((found) => found.id === message.from);
    if (!from) return;

    if (message.t === "asked") this.on.asked(from);
    if (message.t === "answered") {
      this.on.answered(from.id, typeof message.room === "string" ? parseAccessKey(message.room) : null);
    }
  }
}
