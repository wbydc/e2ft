//! Pure count of open sockets per client, so one host cannot hold the server's rooms or its discovery. IPv6 clients count by
//! their /64, the block one home or server usually gets. Counts only live in memory and leave with the last socket.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv6Addr},
};

/// Open sockets one client may hold: room tabs, plus a reconnecting socket while the dead one times out. Many
/// homes and phones share one address behind a carrier NAT, so it is generous.
pub const PER_CLIENT: u32 = 16;

/// Open /discover sockets one client may hold: a page holds one, and a discovery group lists at most this many.
pub const DISCOVER_PER_CLIENT: u32 = 32;

pub struct Sockets {
    open: HashMap<IpAddr, u32>,
    cap: u32,
}

/// The address a client is counted under.
pub fn block(address: IpAddr) -> IpAddr {
    match address.to_canonical() {
        IpAddr::V6(v6) => IpAddr::V6(Ipv6Addr::from(u128::from(v6) & !(u64::MAX as u128))),
        v4 => v4,
    }
}

impl Sockets {
    pub fn new(cap: u32) -> Self {
        Self { open: HashMap::new(), cap }
    }

    /// Counts one more socket for `address`; false, counting nothing, when it already holds `cap`.
    pub fn open(&mut self, address: IpAddr) -> bool {
        let count = self.open.entry(block(address)).or_default();
        if *count >= self.cap {
            return false;
        }
        *count += 1;

        true
    }

    /// One socket that `open` counted closed.
    pub fn close(&mut self, address: IpAddr) {
        let key = block(address);
        if let Some(count) = self.open.get_mut(&key) {
            *count -= 1;
            if *count == 0 {
                self.open.remove(&key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn a_client_gets_per_client_sockets_and_one_more_after_a_close() {
        let mut sockets = Sockets::new(PER_CLIENT);
        for _ in 0..PER_CLIENT {
            assert!(sockets.open(ip("203.0.113.7")));
        }
        assert!(!sockets.open(ip("203.0.113.7")));
        assert!(sockets.open(ip("203.0.113.8")), "another client is not affected");

        sockets.close(ip("203.0.113.7"));
        assert!(sockets.open(ip("203.0.113.7")));
        assert!(!sockets.open(ip("203.0.113.7")));
    }

    #[test]
    fn each_counter_keeps_its_own_cap() {
        let mut sockets = Sockets::new(PER_CLIENT);
        let mut discover = Sockets::new(DISCOVER_PER_CLIENT);
        for _ in 0..DISCOVER_PER_CLIENT {
            assert!(discover.open(ip("203.0.113.7")));
        }
        assert!(!discover.open(ip("203.0.113.7")));
        assert!(sockets.open(ip("203.0.113.7")), "a full discovery count leaves /ws open");
    }

    #[test]
    fn ipv6_counts_by_the_64_block_and_mapped_ipv4_as_ipv4() {
        let mut sockets = Sockets::new(PER_CLIENT);
        for i in 0..PER_CLIENT {
            assert!(sockets.open(ip(&format!("2001:db8:1:2::{i:x}"))));
        }
        assert!(!sockets.open(ip("2001:db8:1:2:ffff::1")), "same /64");
        assert!(sockets.open(ip("2001:db8:1:3::1")), "next /64");

        assert!(sockets.open(ip("::ffff:198.51.100.1")));
        sockets.close(ip("198.51.100.1"));
        assert_eq!(sockets.open.len(), 2, "the mapped address left with its close");
    }

    #[test]
    fn the_last_close_forgets_the_client() {
        let mut sockets = Sockets::new(PER_CLIENT);
        sockets.open(ip("203.0.113.7"));
        sockets.open(ip("203.0.113.7"));
        sockets.close(ip("203.0.113.7"));
        assert_eq!(sockets.open.len(), 1);
        sockets.close(ip("203.0.113.7"));
        assert_eq!(sockets.open.len(), 0);
        sockets.close(ip("203.0.113.7"));
        assert_eq!(sockets.open.len(), 0, "a stray close changes nothing");
    }
}
