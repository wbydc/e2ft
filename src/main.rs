//! e2ft signalling server: serves the embedded frontend and relays opaque sealed frames between the two
//! peers of a room. It never sees secretKey or file metadata and logs nothing.

mod assets;
mod bucket;
mod config;
mod discover;
mod health;
mod http;
mod ice;
mod lobby;
mod metrics;
mod relay;
mod rooms;
mod sockets;
mod stun;

use std::{
    net::SocketAddr,
    sync::{Arc, Mutex, atomic::AtomicU64},
};

use assets::Assets;
use axum::{Router, middleware, routing::get};
use config::Config;
use discover::Cidr;
use ice::Ice;
use lobby::Lobby;
use metrics::Metrics;
use relay::Tx;
use rooms::Rooms;
use sockets::{DISCOVER_PER_CLIENT, PER_CLIENT, Sockets};

/// What every request handler shares: the files to serve, the rooms, open /ws and /discover sockets per client, the next peer id, the
/// ICE servers, the counters, how long a room waits for its joiner, and for discovery the visible home pages, the key
/// their networks are hashed with (random per process, so a hash means nothing outside it) and the proxies whose
/// `X-Forwarded-For` is believed.
struct App {
    assets: Assets,
    rooms: Mutex<Rooms<Tx>>,
    sockets: Mutex<Sockets>,
    discover_sockets: Mutex<Sockets>,
    next_peer: AtomicU64,
    ice: Ice,
    metrics: Metrics,
    lobby: Mutex<Lobby<Tx>>,
    lobby_key: [u8; 32],
    trusted_proxies: Vec<Cidr>,
    room_wait: std::time::Duration,
}

#[tokio::main]
async fn main() {
    // Only a flag is read, never argv[0], and nothing depends on it for security.
    // nosemgrep: rust.lang.security.args-os.args-os
    if std::env::args_os().skip(1).any(|arg| arg == "--health") {
        std::process::exit(health::run());
    }

    let config = Config::from_env();
    let assets = Assets::load(config.assets_dir.as_deref()).unwrap_or_else(|err| panic!("{err}"));
    let has_legal = assets.has_legal();
    let app = Arc::new(App {
        assets,
        rooms: Mutex::new(Rooms::new(config.rooms_per_client)),
        sockets: Mutex::new(Sockets::new(PER_CLIENT)),
        discover_sockets: Mutex::new(Sockets::new(DISCOVER_PER_CLIENT)),
        next_peer: AtomicU64::new(1),
        ice: Ice::from_env(),
        metrics: Metrics::default(),
        lobby: Mutex::new(Lobby::new()),
        lobby_key: discover::random(),
        trusted_proxies: config.trusted_proxies,
        room_wait: config.room_wait,
    });
    tokio::spawn(relay::sweep(app.clone()));
    if let Some(addr) = config.metrics_addr {
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .expect("bind METRICS_ADDR");
        let router = Router::new()
            .route("/metrics", get(metrics::metrics))
            .with_state(app.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.expect("metrics server") });
    }
    let mut router = Router::new()
        .route("/", get(http::index))
        .route("/r/{key}", get(http::index));
    if has_legal {
        router = router
            .route("/terms", get(http::terms))
            .route("/privacy", get(http::privacy));
    }
    let router = router
        .route("/ws", get(relay::ws))
        .route("/discover", get(discover::ws))
        .fallback(http::asset)
        .layer(middleware::map_response(http::security_headers))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(config.addr)
        .await
        .expect("bind ADDR");
    // As PID 1 in a container the default signal handlers do nothing. Rooms live only in memory, so
    // there is nothing to drain: stop at once and let the peers see the socket close.
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("SIGTERM handler");
    tokio::select! {
        r = axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()) => r.expect("server"),
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}
