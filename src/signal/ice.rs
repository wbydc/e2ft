//! ICE servers handed to a peer when its room pairs, and again on request for a new connection. TURN credentials
//! follow coturn's REST scheme (`use-auth-secret`): username = expiry unix time, credential =
//! base64(HMAC-SHA1(secret, username)). Each client has a budget of credentials: coturn keeps an allocation alive for
//! as long as its holder refreshes it, so credentials are the one thing the server can ration.

use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Value, json};
use sha1::Sha1;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Mutex,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use crate::bucket::Bucket;
use crate::signal::sockets::block;

pub(crate) const TURN_TTL_SECS: u64 = 120;
/// TURN credentials one client gets at once, then per second. A pairing costs two (one per peer), each extra relayed
/// lane and each rejoin one more; many phones can share one carrier-NAT address, so it is generous.
const TURN_BURST: f64 = 30.0;
const TURN_PER_SECOND: f64 = 0.2;

pub struct Ice {
    stun: Vec<String>,
    turn: Option<(Vec<String>, Vec<u8>)>,
    budgets: Mutex<HashMap<IpAddr, Bucket>>,
}

pub(crate) fn list(var: &str, default: &str) -> Vec<String> {
    std::env::var(var)
        .unwrap_or_else(|_| default.into())
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

impl Ice {
    /// STUN_URLS (default Google's public STUN, empty for none), TURN_URLS (empty for none) and TURN_SECRET.
    pub fn from_env() -> Self {
        let stun = list("STUN_URLS", "stun:stun.l.google.com:19302");
        let turn_urls = list("TURN_URLS", "");
        let turn = (!turn_urls.is_empty()).then(|| {
            let secret =
                std::env::var("TURN_SECRET").expect("TURN_URLS is set, so TURN_SECRET must be too");
            assert!(
                secret.len() >= 32,
                "TURN_SECRET must be at least 32 characters"
            );
            (turn_urls, secret.into_bytes())
        });
        Ice::new(stun, turn)
    }

    fn new(stun: Vec<String>, turn: Option<(Vec<String>, Vec<u8>)>) -> Self {
        Ice {
            stun,
            turn,
            budgets: Mutex::default(),
        }
    }

    /// Takes `count` TURN credentials from `client`'s budget; false, taking none, means over budget. Always true
    /// without TURN.
    pub fn charge(&self, client: IpAddr, count: u32, now: Instant) -> bool {
        if self.turn.is_none() {
            return true;
        }

        self.budgets
            .lock()
            .unwrap()
            .entry(block(client))
            .or_insert_with(|| Bucket::new(TURN_BURST, TURN_PER_SECOND, now))
            .take(count.into(), now)
    }

    /// Forgets the budgets that have refilled, which a new one would equal.
    pub fn prune(&self, now: Instant) {
        self.budgets.lock().unwrap().retain(|_, bucket| !bucket.is_full(now));
    }

    /// STUN, plus TURN with fresh credentials when `turn` (the client's budget allowed it).
    pub fn servers(&self, turn: bool) -> Value {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after 1970")
            .as_secs();
        self.servers_at(now, turn)
    }

    fn servers_at(&self, now: u64, turn: bool) -> Value {
        let mut servers = vec![];
        if !self.stun.is_empty() {
            servers.push(json!({ "urls": self.stun }));
        }
        if let Some((urls, secret)) = self.turn.as_ref().filter(|_| turn) {
            let username = (now + TURN_TTL_SECS).to_string();
            servers.push(json!({ "urls": urls, "username": username, "credential": credential(secret, &username) }));
        }
        Value::Array(servers)
    }
}

pub(crate) fn credential(secret: &[u8], username: &str) -> String {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret).expect("HMAC takes any key length");
    mac.update(username.as_bytes());
    STANDARD.encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn credential_matches_rfc2202_hmac_sha1() {
        // RFC 2202 test case 2: HMAC-SHA1("Jefe", "what do ya want for nothing?") = effcdf6a...9a7c79
        assert_eq!(
            credential(b"Jefe", "what do ya want for nothing?"),
            "7/zfauXrL6LSdBbV8YTfnCWafHk="
        );
    }

    fn with_turn() -> Ice {
        Ice::new(vec!["stun:s".into()], Some((vec!["turn:t".into()], b"k".to_vec())))
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    /// An ICE with TURN, its client 203.0.113.7 drained of its whole burst at `start`.
    fn drained() -> (Ice, Instant) {
        let ice = with_turn();
        let start = Instant::now();
        for _ in 0..TURN_BURST as u32 / 2 {
            ice.charge(ip("203.0.113.7"), 2, start);
        }

        (ice, start)
    }

    #[test]
    fn turn_entry_expires_after_ttl_and_stun_is_separate() {
        let v = with_turn().servers_at(1_000, true);

        assert_eq!(v[0], json!({ "urls": ["stun:s"] }));
        assert_eq!(v[1]["username"], "1120");
        assert_eq!(v[1]["credential"], credential(b"k", "1120"));
    }

    #[test]
    fn over_budget_gets_stun_only() {
        assert_eq!(with_turn().servers_at(1_000, false), json!([{ "urls": ["stun:s"] }]));
    }

    #[test]
    fn a_client_gets_its_whole_burst() {
        let ice = with_turn();
        let start = Instant::now();

        let charged: Vec<bool> = (0..TURN_BURST as u32 / 2)
            .map(|_| ice.charge(ip("203.0.113.7"), 2, start))
            .collect();

        assert_eq!(charged, vec![true; TURN_BURST as usize / 2], "every pairing of the burst");
    }

    #[test]
    fn one_credential_past_the_burst_is_refused() {
        let (ice, start) = drained();

        let charged = ice.charge(ip("203.0.113.7"), 1, start);

        assert!(!charged, "one past the burst");
    }

    #[test]
    fn another_client_is_not_affected() {
        let (ice, start) = drained();

        let charged = ice.charge(ip("203.0.113.8"), 2, start);

        assert!(charged, "another client is not affected");
    }

    #[test]
    fn a_credential_a_period_later_is_allowed() {
        let (ice, start) = drained();
        let later = start + Duration::from_secs_f64(1.0 / TURN_PER_SECOND);

        let charged = ice.charge(ip("203.0.113.7"), 1, later);

        assert!(charged, "one credential a period later");
    }

    #[test]
    fn only_one_credential_a_period_later() {
        let (ice, start) = drained();
        let later = start + Duration::from_secs_f64(1.0 / TURN_PER_SECOND);
        ice.charge(ip("203.0.113.7"), 1, later);

        let charged = ice.charge(ip("203.0.113.7"), 1, later);

        assert!(!charged, "only one");
    }

    #[test]
    fn a_client_gets_its_whole_budget() {
        let ice = with_turn();
        let start = Instant::now();

        let charged = ice.charge(ip("203.0.113.7"), TURN_BURST as u32, start);

        assert!(charged);
    }

    #[test]
    fn ipv6_clients_share_a_budget_per_64() {
        let ice = with_turn();
        let start = Instant::now();
        ice.charge(ip("2001:db8:1:2::1"), TURN_BURST as u32, start);

        let charged = ice.charge(ip("2001:db8:1:2::ffff"), 1, start);

        assert!(!charged, "same /64");
    }

    #[test]
    fn the_next_64_has_its_own_budget() {
        let ice = with_turn();
        let start = Instant::now();
        ice.charge(ip("2001:db8:1:2::1"), TURN_BURST as u32, start);

        let charged = ice.charge(ip("2001:db8:1:3::1"), 1, start);

        assert!(charged, "next /64");
    }

    #[test]
    fn prune_keeps_a_half_refilled_budget() {
        let ice = with_turn();
        let start = Instant::now();
        ice.charge(ip("203.0.113.7"), TURN_BURST as u32, start);
        let refill = Duration::from_secs_f64(TURN_BURST / TURN_PER_SECOND);
        ice.prune(start + refill / 2);

        let charged = ice.charge(ip("203.0.113.7"), TURN_BURST as u32, start + refill / 2);

        assert!(!charged, "half refilled, kept");
    }

    #[test]
    fn prune_forgets_a_refilled_budget() {
        let ice = with_turn();
        let start = Instant::now();
        ice.charge(ip("203.0.113.7"), TURN_BURST as u32, start);
        let refill = Duration::from_secs_f64(TURN_BURST / TURN_PER_SECOND);
        ice.prune(start + refill / 2);
        ice.prune(start + refill);

        let kept = ice.budgets.lock().unwrap().len();

        assert_eq!(kept, 0);
    }

    #[test]
    fn no_servers_when_unconfigured() {
        let ice = Ice::new(vec![], None);

        let servers = ice.servers_at(0, true);

        assert_eq!(servers, json!([]));
    }

    #[test]
    fn no_budget_is_kept_when_unconfigured() {
        let ice = Ice::new(vec![], None);

        let charged = ice.charge(ip("203.0.113.7"), 1_000, Instant::now());
        let kept = ice.budgets.lock().unwrap().len();

        assert!(charged);
        assert_eq!(kept, 0);
    }
}
