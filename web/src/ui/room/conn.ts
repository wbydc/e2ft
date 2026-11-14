// Connection card: direct or relayed, read from the selected ICE candidate pair.
import { bindText } from "../../i18n/index.ts";
import type { Text } from "../../i18n/index.ts";
import type { Route } from "../../net/peer.ts";
import { $ } from "../dom.ts";
import { isLively } from "../motion.ts";

/** `route` is the live peer's selected pair, or undefined while there is no peer; `lanes` counts the open connections each
 *  direction's running transfer uses, 0 with none. */
export function setupConnInfo(
  route: () => Promise<Route | null> | undefined,
  lanes: () => { out: number; in: number },
) {
  $("conn-btn").addEventListener("click", () => {
    void route()?.then((selectedRoute) => {
      // shortcut: a LAN peer behind mDNS can show as prflx and read as "through NAT"; fine for a hint.
      const relay = !!selectedRoute && (selectedRoute.local === "relay" || selectedRoute.remote === "relay");
      const sameNetwork = !!selectedRoute && selectedRoute.local === "host" && selectedRoute.remote === "host";
      const path: Text = !selectedRoute
        ? (m) => m.connUnknown
        : relay
          ? (m) => m.connRelay
          : sameNetwork
            ? (m) => m.connLan
            : (m) => m.connNat;

      // The drawing is decoration; the text above stays the accessible content.
      const graph = $("conn-graph");
      graph.classList.remove("is-direct", "is-lan", "is-nat", "is-relay");
      if (isLively() && selectedRoute) {
        if (relay) graph.classList.add("is-relay");
        else graph.classList.add("is-direct", sameNetwork ? "is-lan" : "is-nat");
      }

      bindText($("conn-path"), path);
      bindText($("conn-detail"), (m) =>
        selectedRoute
          ? m.connDetail(
              selectedRoute.local,
              selectedRoute.remote,
              selectedRoute.protocol,
              selectedRoute.rtt,
              lanes().out,
              lanes().in,
            )
          : "",
      );

      const dialog = $<HTMLDialogElement>("conn");
      if (!dialog.open) dialog.showModal();
    });
  });
}

/** Connected: the card's button shows; disconnected: it hides and an open card closes. */
export function setConnInfo(on: boolean) {
  $("conn-btn").hidden = !on;
  if (!on && $<HTMLDialogElement>("conn").open) $<HTMLDialogElement>("conn").close();
}
