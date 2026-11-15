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
use crate::sockets::block;

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
    fn a_client_gets_the_burst_then_the_rate_and_others_are_not_affected() {
        let ice = with_turn();
        let start = Instant::now();
        for credential in 0..TURN_BURST as u32 / 2 {
            assert!(ice.charge(ip("203.0.113.7"), 2, start), "pairing {credential} of the burst");
        }
        assert!(!ice.charge(ip("203.0.113.7"), 1, start), "one past the burst");
        assert!(ice.charge(ip("203.0.113.8"), 2, start), "another client is not affected");

        let later = start + Duration::from_secs_f64(1.0 / TURN_PER_SECOND);
        assert!(ice.charge(ip("203.0.113.7"), 1, later), "one credential a period later");
        assert!(!ice.charge(ip("203.0.113.7"), 1, later), "only one");
    }

    #[test]
    fn ipv6_clients_share_a_budget_per_64() {
        let ice = with_turn();
        let start = Instant::now();
        assert!(ice.charge(ip("2001:db8:1:2::1"), TURN_BURST as u32, start));
        assert!(!ice.charge(ip("2001:db8:1:2::ffff"), 1, start), "same /64");
        assert!(ice.charge(ip("2001:db8:1:3::1"), 1, start), "next /64");
    }

    #[test]
    fn prune_forgets_only_refilled_budgets() {
        let ice = with_turn();
        let start = Instant::now();
        assert!(ice.charge(ip("203.0.113.7"), TURN_BURST as u32, start));
        let refill = Duration::from_secs_f64(TURN_BURST / TURN_PER_SECOND);

        ice.prune(start + refill / 2);
        assert!(!ice.charge(ip("203.0.113.7"), TURN_BURST as u32, start + refill / 2), "half refilled, kept");

        ice.prune(start + refill);
        assert!(ice.budgets.lock().unwrap().is_empty());
    }

    #[test]
    fn no_servers_and_no_budget_when_unconfigured() {
        let ice = Ice::new(vec![], None);
        assert_eq!(ice.servers_at(0, true), json!([]));
        assert!(ice.charge(ip("203.0.113.7"), 1_000, Instant::now()));
        assert!(ice.budgets.lock().unwrap().is_empty());
    }
}
