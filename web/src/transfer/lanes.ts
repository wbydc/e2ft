// The connections a transfer's chunks travel on: connection 0, which the room owns (a Link),
// and the extra connections (Lane) a sender opens per transfer, as many as laneCap allows.
import type { Sealer } from "../crypto/sealer.ts";
import { isTurnUrl } from "../net/ice.ts";
import type { Lane } from "../net/lane.ts";
import { MAX_DIRECT, TURN_QUOTA } from "./constants.ts";

/** Connection 0's config and whether its route is relayed, read when a transfer starts. */
export interface LanePlan {
  config: RTCConfiguration;
  relayed: boolean;
}

/** The connection a room currently has: connection 0's channels, its control sealer, and its lane plan. */
export interface Link {
  data: RTCDataChannel;
  control: RTCDataChannel;
  sealer: Sealer;
  plan: () => Promise<LanePlan>;
}

/** Extra connections copy connection 0's route kind: after a direct one they drop TURN, which would book relay
 *  allocations (one per TURN URL on each side) that they never use. */
export function laneConfig(plan: LanePlan): RTCConfiguration {
  if (plan.relayed) return plan.config;

  const iceServers = (plan.config.iceServers ?? [])
    // oxlint-disable-next-line oxc/no-map-spread -- copies on purpose: plan.config is connection 0's live config
    .map((server) => ({ ...server, urls: [server.urls].flat().filter((url) => !isTurnUrl(url)) }))
    .filter((server) => server.urls.length > 0);

  return { ...plan.config, iceServers };
}

/** Connections one direction may use, connection 0 included. Relayed: what the pairing's TURN quota holds, split
 *  in half when files go both ways. */
export function laneCap(plan: LanePlan, bothWays: boolean): number {
  if (!plan.relayed) return MAX_DIRECT;

  const urls = (plan.config.iceServers ?? []).flatMap((server) => [server.urls].flat()).filter(isTurnUrl).length;
  const extra = Math.max(0, Math.floor(TURN_QUOTA / (2 * Math.max(1, urls))) - 1);

  return 1 + (bothWays ? Math.floor(extra / 2) : extra);
}

/** Connections carrying chunks: connection 0 and the open extra ones. */
export const openLanes = (lanes: Map<number, Lane>): number =>
  1 + [...lanes.values()].filter((lane) => lane.channel.readyState === "open").length;

export function closeLanes(lanes: Map<number, Lane>): void {
  for (const lane of lanes.values()) lane.close();
  lanes.clear();
}
