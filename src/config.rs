//! Settings read from the environment at startup. TURN settings are read by `ice::Ice::from_env`.

use std::{net::SocketAddr, path::PathBuf, time::Duration};

use crate::discover::Cidr;
use crate::settings::Settings;

/// Where the server listens without `ADDR`.
pub(crate) const ADDR: &str = "127.0.0.1:8080";

pub(crate) struct Config {
    /// `ADDR`: where the public server listens.
    pub(crate) addr: SocketAddr,
    /// `METRICS=true` turns on `/metrics` on `METRICS_ADDR`, never on the public router.
    pub(crate) metrics_addr: Option<SocketAddr>,
    /// `ASSETS_DIR`: the optional folder served over the embedded frontend (src/assets.rs); empty is unset.
    pub(crate) assets_dir: Option<PathBuf>,
    /// `TRUSTED_PROXIES`: comma-separated addresses or CIDR blocks of the reverse proxies in front of the server,
    /// whose `X-Forwarded-For` names the client. Empty: the socket's peer is the client.
    pub(crate) trusted_proxies: Vec<Cidr>,
    /// `ROOM_WAIT`: seconds a new room waits for its joiner before it is deleted, 900 by default.
    pub(crate) room_wait: Duration,
    /// `ROOMS_PER_CLIENT`: live rooms one client address (IPv6 by its /64) may have created, 16 by default.
    pub(crate) rooms_per_client: u32,
    /// The tuning settings both halves share (src/settings.rs).
    pub(crate) settings: Settings,
}

impl Config {
    pub(crate) fn from_env() -> Config {
        let addr = address("ADDR", ADDR);
        let metrics_addr = match std::env::var("METRICS").as_deref() {
            Ok("true") => Some(address("METRICS_ADDR", "127.0.0.1:9090")),
            Ok("false") | Err(_) => None,
            Ok(_) => panic!("METRICS must be true or false"),
        };
        let assets_dir = std::env::var_os("ASSETS_DIR")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from);
        let trusted_proxies = std::env::var("TRUSTED_PROXIES")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|block| !block.is_empty())
            .map(|block| {
                Cidr::parse(block)
                    .unwrap_or_else(|| panic!("TRUSTED_PROXIES: {block} is not an address or CIDR block"))
            })
            .collect();
        let room_wait = std::env::var("ROOM_WAIT")
            .map(|text| text.parse().expect("ROOM_WAIT must be whole seconds"))
            .unwrap_or(900);
        let rooms_per_client = std::env::var("ROOMS_PER_CLIENT")
            .map(|text| text.parse().expect("ROOMS_PER_CLIENT must be a whole number"))
            .unwrap_or(crate::rooms::ROOMS_PER_CLIENT);

        Config {
            addr,
            metrics_addr,
            assets_dir,
            trusted_proxies,
            room_wait: Duration::from_secs(room_wait),
            rooms_per_client,
            settings: Settings::from_env().unwrap_or_else(|err| panic!("{err}")),
        }
    }
}

pub(crate) fn address(name: &str, default: &str) -> SocketAddr {
    std::env::var(name)
        .unwrap_or_else(|_| default.into())
        .parse()
        .unwrap_or_else(|_| panic!("{name} must be host:port"))
}
