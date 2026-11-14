// ICE configuration: which STUN/TURN servers a connection uses and whether it is forced through
// TURN. Pure functions over RTCIceServer lists; the settings they read live in settings.ts.
import type { Turn } from "./settings.ts";

/** A `turn:` or `turns:` URL: the only kind that can give a relay candidate. */
export const isTurnUrl = (u: string) => /^turns?:/i.test(u);

/** An own TURN server replaces every server-sent one, STUN included, so nothing touches ours. */
export const iceServers = (turn: Turn | null, fromServer: RTCIceServer[]): RTCIceServer[] =>
  turn ? [{ urls: turn.urls, username: turn.username, credential: turn.credential }] : fromServer;

/** How a custom room connects. Never saved with the defaults; the joiner learns it sealed. */
export type Connection = "auto" | "relay" | "tcp";

/** The peer's `relay` message is untrusted: anything but a boolean `tcp` is null. */
export const parseRelay = (raw: unknown): Connection | null => {
  const tcpFlag = (raw as { tcp?: unknown } | null)?.tcp;

  return typeof tcpFlag === "boolean" ? (tcpFlag ? "tcp" : "relay") : null;
};

/** Relay forces TURN; tcp also moves every `turn:` URL to TCP. `turns:` is TLS over TCP already, `stun:` goes unused. */
const toTcp = (u: string) => (u.startsWith("turn:") ? u.replace(/\?.*$/, "") + "?transport=tcp" : u);

export function relayConfig(servers: RTCIceServer[], mode: Connection): RTCConfiguration {
  if (mode === "auto") return { iceServers: servers, iceTransportPolicy: "all" };

  const relayServers =
    mode === "tcp" ? servers.map((s) => ({ ...s, urls: [...new Set([s.urls].flat().map(toTcp))] })) : servers;

  return { iceServers: relayServers, iceTransportPolicy: "relay" };
}

/** Swaps the server's fresh TURN credentials into the entries that still carry the pairing's ones, keeping their
 *  URLs (TCP rewrites included). An own or shared TURN server has other credentials and stays as it is. */
export function withFreshTurn(
  config: RTCConfiguration,
  paired: RTCIceServer[],
  fresh: RTCIceServer[],
): RTCConfiguration {
  const old = paired.find((server) => server.username);
  const next = fresh.find((server) => server.username);
  if (!old || !next) return config;

  // oxlint-disable-next-line oxc/no-map-spread -- copies on purpose: config is connection 0's live config
  const servers = (config.iceServers ?? []).map((server) =>
    server.username === old.username && server.credential === old.credential
      ? { ...server, username: next.username, credential: next.credential }
      : server,
  );

  return { ...config, iceServers: servers };
}
