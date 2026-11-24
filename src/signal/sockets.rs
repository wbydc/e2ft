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

    fn filled(cap: u32) -> Sockets {
        let mut sockets = Sockets::new(cap);
        for _ in 0..cap {
            sockets.open(ip("203.0.113.7"));
        }

        sockets
    }

    fn filled_ipv6() -> Sockets {
        let mut sockets = Sockets::new(PER_CLIENT);
        for i in 0..PER_CLIENT {
            sockets.open(ip(&format!("2001:db8:1:2::{i:x}")));
        }

        sockets
    }

    #[test]
    fn a_client_gets_its_whole_share() {
        let mut sockets = Sockets::new(PER_CLIENT);

        let opened: Vec<bool> =
            (0..PER_CLIENT).map(|_| sockets.open(ip("203.0.113.7"))).collect();

        assert!(opened.iter().all(|allowed| *allowed));
    }

    #[test]
    fn a_discovery_counter_gets_its_whole_share() {
        let mut discover = Sockets::new(DISCOVER_PER_CLIENT);

        let opened: Vec<bool> =
            (0..DISCOVER_PER_CLIENT).map(|_| discover.open(ip("203.0.113.7"))).collect();

        assert!(opened.iter().all(|allowed| *allowed));
    }

    #[test]
    fn an_ipv6_client_gets_its_whole_share() {
        let mut sockets = Sockets::new(PER_CLIENT);

        let opened: Vec<bool> = (0..PER_CLIENT)
            .map(|i| sockets.open(ip(&format!("2001:db8:1:2::{i:x}"))))
            .collect();

        assert!(opened.iter().all(|allowed| *allowed));
    }

    #[test]
    fn a_client_gets_exactly_per_client_sockets() {
        let mut sockets = filled(PER_CLIENT);

        let extra = sockets.open(ip("203.0.113.7"));

        assert!(!extra);
    }

    #[test]
    fn another_client_is_not_affected_by_a_full_one() {
        let mut sockets = filled(PER_CLIENT);

        let opened = sockets.open(ip("203.0.113.8"));

        assert!(opened, "another client is not affected");
    }

    #[test]
    fn a_close_frees_one_socket() {
        let mut sockets = filled(PER_CLIENT);
        sockets.close(ip("203.0.113.7"));

        let opened = sockets.open(ip("203.0.113.7"));

        assert!(opened);
    }

    #[test]
    fn a_closed_slot_is_taken_up_again() {
        let mut sockets = filled(PER_CLIENT);
        sockets.close(ip("203.0.113.7"));
        sockets.open(ip("203.0.113.7"));

        let extra = sockets.open(ip("203.0.113.7"));

        assert!(!extra);
    }

    #[test]
    fn a_discovery_counter_stops_at_its_cap() {
        let mut discover = filled(DISCOVER_PER_CLIENT);

        let extra = discover.open(ip("203.0.113.7"));

        assert!(!extra);
    }

    #[test]
    fn a_full_discovery_count_leaves_room_sockets_open() {
        let mut sockets = Sockets::new(PER_CLIENT);
        let _discover = filled(DISCOVER_PER_CLIENT);

        let opened = sockets.open(ip("203.0.113.7"));

        assert!(opened, "a full discovery count leaves /ws open");
    }

    #[test]
    fn ipv6_sockets_count_by_the_64_block() {
        let mut sockets = filled_ipv6();

        let extra = sockets.open(ip("2001:db8:1:2:ffff::1"));

        assert!(!extra, "same /64");
    }

    #[test]
    fn the_next_64_is_a_different_client() {
        let mut sockets = filled_ipv6();

        let opened = sockets.open(ip("2001:db8:1:3::1"));

        assert!(opened, "next /64");
    }

    #[test]
    fn a_mapped_ipv4_address_closes_with_its_ipv4() {
        let mut sockets = Sockets::new(PER_CLIENT);
        sockets.open(ip("2001:db8:1:2::1"));
        sockets.open(ip("2001:db8:1:3::1"));
        sockets.open(ip("::ffff:198.51.100.1"));
        sockets.close(ip("198.51.100.1"));

        let keys = sockets.open.len();

        assert_eq!(keys, 2, "the mapped address left with its close");
    }

    #[test]
    fn a_close_keeps_the_client_while_a_socket_is_open() {
        let mut sockets = Sockets::new(PER_CLIENT);
        sockets.open(ip("203.0.113.7"));
        sockets.open(ip("203.0.113.7"));

        sockets.close(ip("203.0.113.7"));

        let keys = sockets.open.len();

        assert_eq!(keys, 1);
    }

    #[test]
    fn the_last_close_forgets_the_client() {
        let mut sockets = Sockets::new(PER_CLIENT);
        sockets.open(ip("203.0.113.7"));
        sockets.open(ip("203.0.113.7"));
        sockets.close(ip("203.0.113.7"));

        sockets.close(ip("203.0.113.7"));

        let keys = sockets.open.len();

        assert_eq!(keys, 0);
    }

    #[test]
    fn a_stray_close_changes_nothing() {
        let mut sockets = Sockets::new(PER_CLIENT);
        sockets.open(ip("203.0.113.7"));
        sockets.open(ip("203.0.113.7"));
        sockets.close(ip("203.0.113.7"));
        sockets.close(ip("203.0.113.7"));

        sockets.close(ip("203.0.113.7"));

        let keys = sockets.open.len();

        assert_eq!(keys, 0, "a stray close changes nothing");
    }
}
