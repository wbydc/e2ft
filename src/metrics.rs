//! Counters and the Prometheus text for /metrics: aggregate numbers only, never a key, token or
//! address.

use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use axum::{
    extract::State,
    http::header,
    response::{IntoResponse, Response},
};

use crate::App;
use crate::signal::rooms::{End, Stats};

/// The codes `e2ft_errors_total` counts: the room errors, a refused keep-alive, a client over its socket count and
/// a socket over its byte rate.
const ERROR_CODES: [&str; 7] = ["exists", "not-found", "full", "busy", "keep-alive", "too-many", "rate"];

/// Counters for /metrics. Room ends and gauges come from `Rooms::stats`.
#[derive(Default)]
pub(crate) struct Metrics {
    pub(crate) created: AtomicU64,
    pub(crate) joined: AtomicU64,
    pub(crate) rejoined: AtomicU64,
    errors: [AtomicU64; 7],
    pub(crate) relayed_frames: AtomicU64,
    pub(crate) relayed_bytes: AtomicU64,
    pub(crate) dropped_frames: AtomicU64,
    pub(crate) turn_withheld: AtomicU64,
}

impl Metrics {
    pub(crate) fn bump(c: &AtomicU64, n: u64) {
        c.fetch_add(n, Ordering::Relaxed);
    }

    pub(crate) fn error(&self, code: &str) {
        if let Some(i) = ERROR_CODES.iter().position(|c| *c == code) {
            Metrics::bump(&self.errors[i], 1);
        }
    }
}

/// Prometheus text format 0.0.4: aggregate numbers only, never a key, token or address.
pub(crate) fn render(m: &Metrics, s: &Stats, discoverable: u64) -> String {
    fn family(o: &mut String, name: &str, kind: &str, help: &str, samples: &[(String, u64)]) {
        o.push_str(&format!("# HELP {name} {help}\n# TYPE {name} {kind}\n"));
        for (labels, v) in samples {
            o.push_str(&format!("{name}{labels} {v}\n"));
        }
    }
    let one = |v: u64| [(String::new(), v)];
    let get = |c: &AtomicU64| c.load(Ordering::Relaxed);
    let mut o = String::new();
    family(
        &mut o,
        "e2ft_build_info",
        "gauge",
        "Always 1; the version label is the running build.",
        &[(format!("{{version=\"{}\"}}", env!("CARGO_PKG_VERSION")), 1)],
    );
    family(
        &mut o,
        "e2ft_in_use",
        "gauge",
        "1 while at least one room exists.",
        &one((s.rooms > 0) as u64),
    );
    family(
        &mut o,
        "e2ft_rooms",
        "gauge",
        "Rooms in memory.",
        &one(s.rooms),
    );
    family(
        &mut o,
        "e2ft_peers",
        "gauge",
        "Seats with a connected socket.",
        &one(s.here),
    );
    family(
        &mut o,
        "e2ft_away_seats",
        "gauge",
        "Seats waiting out their keep-alive.",
        &one(s.away),
    );
    family(
        &mut o,
        "e2ft_discoverable",
        "gauge",
        "Home pages visible to their network.",
        &one(discoverable),
    );
    family(
        &mut o,
        "e2ft_rooms_created_total",
        "counter",
        "Rooms created.",
        &one(get(&m.created)),
    );
    family(
        &mut o,
        "e2ft_joins_total",
        "counter",
        "Joiner seats taken.",
        &one(get(&m.joined)),
    );
    family(
        &mut o,
        "e2ft_rejoins_total",
        "counter",
        "Seats taken back after a drop.",
        &one(get(&m.rejoined)),
    );
    let errors: Vec<_> = ERROR_CODES
        .iter()
        .zip(&m.errors)
        .map(|(c, n)| (format!("{{code=\"{c}\"}}"), get(n)))
        .collect();
    family(
        &mut o,
        "e2ft_errors_total",
        "counter",
        "Hellos refused, by error code.",
        &errors,
    );
    let ended: Vec<_> = End::ALL
        .iter()
        .map(|e| (format!("{{cause=\"{}\"}}", e.code()), s.ended[*e as usize]))
        .collect();
    family(
        &mut o,
        "e2ft_rooms_ended_total",
        "counter",
        "Rooms deleted, by cause.",
        &ended,
    );
    family(
        &mut o,
        "e2ft_relayed_frames_total",
        "counter",
        "Sealed frames relayed.",
        &one(get(&m.relayed_frames)),
    );
    family(
        &mut o,
        "e2ft_relayed_bytes_total",
        "counter",
        "Bytes of sealed frames relayed.",
        &one(get(&m.relayed_bytes)),
    );
    family(
        &mut o,
        "e2ft_dropped_frames_total",
        "counter",
        "Frames dropped: the other peer's queue was full or closed.",
        &one(get(&m.dropped_frames)),
    );
    family(
        &mut o,
        "e2ft_turn_withheld_total",
        "counter",
        "TURN credentials withheld: the client was over its budget.",
        &one(get(&m.turn_withheld)),
    );
    o
}

pub(crate) async fn metrics(State(app): State<Arc<App>>) -> Response {
    let stats = app.rooms.lock().unwrap().stats();
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        render(&app.metrics, &stats, app.lobby.lock().unwrap().count()),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_render_every_family_and_no_room_data() {
        let m = Metrics::default();
        m.error("full");
        m.error("not a code");
        Metrics::bump(&m.relayed_bytes, 4096);
        let idle = render(&m, &Stats::default(), 0);
        assert!(idle.contains("\ne2ft_in_use 0\n"));
        let busy = render(
            &m,
            &Stats {
                rooms: 2,
                here: 3,
                away: 1,
                ended: [5, 0, 1, 2],
            },
            4,
        );
        for line in [
            "e2ft_in_use 1",
            "e2ft_rooms 2",
            "e2ft_peers 3",
            "e2ft_away_seats 1",
            "e2ft_discoverable 4",
            "e2ft_errors_total{code=\"full\"} 1",
            "e2ft_errors_total{code=\"exists\"} 0",
            "e2ft_rooms_ended_total{cause=\"leave\"} 5",
            "e2ft_rooms_ended_total{cause=\"expired\"} 1",
            "e2ft_rooms_ended_total{cause=\"unjoined\"} 2",
            "e2ft_relayed_bytes_total 4096",
            "e2ft_turn_withheld_total 0",
            "# TYPE e2ft_rooms_created_total counter",
            "# TYPE e2ft_peers gauge",
        ] {
            assert!(
                busy.lines().any(|l| l == line),
                "missing {line:?} in\n{busy}"
            );
        }
        let families = busy.lines().filter(|l| l.starts_with("# TYPE ")).count();
        assert_eq!(families, 15);
        assert!(busy.lines().any(|l| l
            == format!(
                "e2ft_build_info{{version=\"{}\"}} 1",
                env!("CARGO_PKG_VERSION")
            )));
        assert!(
            busy.lines()
                .filter(|l| !l.starts_with('#'))
                .all(|l| l.starts_with("e2ft_"))
        );
    }
}
