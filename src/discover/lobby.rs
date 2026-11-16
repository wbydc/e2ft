//! Pure same-network discovery state: the home pages behind one public address, grouped by a keyed hash of
//! it so the address is never stored. No I/O; `T` is a member's send handle.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};

use sha2::{Digest, Sha256};

pub type LobbyId = u64;

/// Most members one group holds; a carrier-grade NAT can put many strangers behind one address.
pub const GROUP_MAX: usize = 32;
/// Longest name or device label, in chars.
pub const LABEL_MAX: usize = 32;
/// Open asks one member holds; past it the oldest is forgotten and its answer dropped.
const OPEN_ASKS_MAX: usize = GROUP_MAX;

const TAG_IPV4: u8 = 4;
const TAG_IPV6: u8 = 6;

/// A keyed hash of the client's network, so the address itself is never stored.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Network([u8; 32]);

impl Network {
    /// `direct`: `address` is the socket's own peer address, not one read from a proxy header.
    /// None when the address must never form a group.
    pub fn new(key: &[u8; 32], address: IpAddr, direct: bool) -> Option<Network> {
        match address {
            IpAddr::V4(address) => Some(hashed(key, TAG_IPV4, &ipv4_bytes(address, direct)?)),
            IpAddr::V6(address) => match address.to_ipv4_mapped() {
                Some(address) => Some(hashed(key, TAG_IPV4, &ipv4_bytes(address, direct)?)),
                None => Some(hashed(key, TAG_IPV6, &ipv6_prefix(address, direct)?)),
            },
        }
    }
}

fn hashed(key: &[u8; 32], tag: u8, bytes: &[u8]) -> Network {
    let mut hasher = Sha256::new();
    hasher.update(key);
    hasher.update([tag]);
    hasher.update(bytes);
    Network(hasher.finalize().into())
}

fn ipv4_bytes(address: Ipv4Addr, direct: bool) -> Option<[u8; 4]> {
    let octets = address.octets();
    // 100.64.0.0/10 is carrier-grade NAT: many strangers behind one address.
    let shared = octets[0] == 100 && (octets[1] & 0xc0) == 64;
    if address.is_unspecified()
        || address.is_private()
        || address.is_link_local()
        || shared
        || address.is_broadcast()
        || address.is_multicast()
        || address.is_documentation()
    {
        return None;
    }
    if address.is_loopback() && !direct {
        return None;
    }

    Some(octets)
}

/// Only the /64 goes into the hash, so one provider prefix gives one group.
fn ipv6_prefix(address: Ipv6Addr, direct: bool) -> Option<[u8; 8]> {
    let octets = address.octets();
    // unique local fc00::/7 and link-local fe80::/10.
    if address.is_unspecified()
        || address.is_multicast()
        || (octets[0] & 0xfe) == 0xfc
        || (octets[0] == 0xfe && (octets[1] & 0xc0) == 0x80)
    {
        return None;
    }
    if address.is_loopback() && !direct {
        return None;
    }

    let mut prefix = [0u8; 8];
    prefix.copy_from_slice(&octets[..8]);

    Some(prefix)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub name: String,
    pub device: String,
}

impl Device {
    /// None unless both labels are valid (see rules).
    pub fn new(name: &str, device: &str) -> Option<Device> {
        Some(Device {
            name: label(name)?,
            device: label(device)?,
        })
    }
}

/// Trimmed, 1 to LABEL_MAX chars, no control character.
fn label(value: &str) -> Option<String> {
    let value = value.trim();
    let chars = value.chars().count();
    if chars == 0 || chars > LABEL_MAX || value.chars().any(char::is_control) {
        return None;
    }

    Some(value.to_owned())
}

/// Frames of one kind a socket may send in a row before the steady rate applies.
pub const BURST: f64 = 5.0;
/// The steady rate, frames per second.
pub const PER_SECOND: f64 = 1.0;

#[derive(Debug, PartialEq, Eq)]
pub enum LobbyError {
    Full,
}

struct Member<T> {
    id: LobbyId,
    device: Device,
    tx: T,
    /// Open asks to this member, oldest first, one entry per ask; each lets one answer through.
    asked_by: Vec<LobbyId>,
}

pub struct Lobby<T> {
    groups: HashMap<Network, Vec<Member<T>>>,
}

impl<T> Lobby<T> {
    pub fn new() -> Self {
        Lobby {
            groups: HashMap::new(),
        }
    }

    /// Adds the member, or replaces its Device when `id` is already in that group (a rename). Ok(true) when the
    /// group changed, Ok(false) for a rename to the same Device. Err(Full) when the group already holds GROUP_MAX
    /// other members; a rename never fails.
    pub fn enter(
        &mut self,
        network: &Network,
        id: LobbyId,
        device: Device,
        tx: T,
    ) -> Result<bool, LobbyError> {
        let members = self.groups.entry(network.clone()).or_default();
        if let Some(member) = members.iter_mut().find(|member| member.id == id) {
            let changed = member.device != device;
            member.device = device;

            return Ok(changed);
        }
        if members.len() >= GROUP_MAX {
            return Err(LobbyError::Full);
        }
        members.push(Member {
            id,
            device,
            tx,
            asked_by: Vec::new(),
        });

        Ok(true)
    }

    /// Removes the member; an emptied group is removed from the map. Unknown ids do nothing.
    pub fn leave(&mut self, network: &Network, id: LobbyId) {
        let Some(members) = self.groups.get_mut(network) else {
            return;
        };
        members.retain(|member| member.id != id);
        for member in members.iter_mut() {
            member.asked_by.retain(|asker| *asker != id);
        }
        let empty = members.is_empty();

        if empty {
            self.groups.remove(network);
        }
    }

    /// Every member of the group in the order they entered: (id, device, send handle). Empty for an unknown group.
    pub fn members(&self, network: &Network) -> Vec<(LobbyId, &Device, &T)> {
        match self.groups.get(network) {
            Some(members) => members
                .iter()
                .map(|member| (member.id, &member.device, &member.tx))
                .collect(),
            None => Vec::new(),
        }
    }

    /// The send handle of `to` for an ask from `from`, both in this group; `to` may then answer that ask once.
    pub fn ask(&mut self, network: &Network, from: LobbyId, to: LobbyId) -> Option<&T> {
        let members = self.groups.get_mut(network)?;
        if from == to || !members.iter().any(|member| member.id == from) {
            return None;
        }
        let asked = members.iter_mut().find(|member| member.id == to)?;
        if asked.asked_by.len() >= OPEN_ASKS_MAX {
            asked.asked_by.remove(0);
        }
        asked.asked_by.push(from);

        Some(&asked.tx)
    }

    /// The send handle of `to` for an answer from `from`, only if `to` has an ask to `from` not yet answered.
    pub fn answer(&mut self, network: &Network, from: LobbyId, to: LobbyId) -> Option<&T> {
        let members = self.groups.get_mut(network)?;
        let answering = members.iter_mut().find(|member| member.id == from)?;
        let index = answering.asked_by.iter().position(|asker| *asker == to)?;
        answering.asked_by.remove(index);

        members
            .iter()
            .find(|member| member.id == to)
            .map(|member| &member.tx)
    }

    /// Members over all groups (for a metrics gauge).
    pub fn count(&self) -> u64 {
        self.groups.values().map(|members| members.len() as u64).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7; 32];

    fn network(address: &str) -> Network {
        let address: IpAddr = address.parse().expect("address");
        Network::new(&KEY, address, true).expect("network")
    }

    fn device(label: &str) -> Device {
        Device::new(label, label).expect("device")
    }

    #[test]
    fn one_ipv4_address_gives_one_network() {
        assert!(network("8.8.8.8") == network("8.8.8.8"), "same address");
        assert!(network("8.8.8.8") != network("8.8.4.4"), "different address");
        let address: IpAddr = "8.8.8.8".parse().unwrap();
        let other_key = [8; 32];
        assert!(
            Network::new(&KEY, address, true).unwrap() != Network::new(&other_key, address, true).unwrap(),
            "a different key gives a different network"
        );
    }

    #[test]
    fn ipv6_groups_by_64_and_a_mapped_address_matches_its_ipv4() {
        assert!(network("2606:4700:4700::1") == network("2606:4700:4700::2222"), "one /64");
        assert!(network("2606:4700:4700::1") != network("2606:4700:4701::1"), "other /64");
        assert!(network("::ffff:8.8.8.8") == network("8.8.8.8"), "mapped is IPv4");
    }

    #[test]
    fn non_public_addresses_never_form_a_group() {
        for address in [
            "10.244.3.7",
            "10.0.0.1",
            "192.168.1.2",
            "172.16.0.1",
            "100.64.0.1",
            "169.254.1.1",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "fc00::1",
            "fe80::1",
        ] {
            let address: IpAddr = address.parse().expect("address");
            assert!(Network::new(&KEY, address, true).is_none(), "{address} direct");
            assert!(Network::new(&KEY, address, false).is_none(), "{address} from a header");
        }
    }

    #[test]
    fn loopback_forms_a_group_only_from_the_socket_address() {
        for address in ["127.0.0.1", "::1"] {
            let address: IpAddr = address.parse().expect("address");
            assert!(Network::new(&KEY, address, true).is_some(), "{address} direct");
            assert!(
                Network::new(&KEY, address, false).is_none(),
                "{address} from a header"
            );
        }
    }

    #[test]
    fn members_lists_one_group_in_enter_order() {
        let mut lobby = Lobby::new();
        let home = network("8.8.8.8");
        let elsewhere = network("1.1.1.1");
        lobby.enter(&home, 2, device("phone"), "tx-2").unwrap();
        lobby.enter(&home, 1, device("laptop"), "tx-1").unwrap();
        lobby.enter(&elsewhere, 3, device("tablet"), "tx-3").unwrap();
        assert_eq!(
            lobby.members(&home),
            vec![(2, &device("phone"), &"tx-2"), (1, &device("laptop"), &"tx-1")]
        );
        assert_eq!(lobby.ask(&home, 1, 3), None, "a member of another group");
        assert_eq!(lobby.ask(&elsewhere, 3, 3), None, "itself");
        assert_eq!(lobby.ask(&home, 1, 2), Some(&"tx-2"));
        assert_eq!(lobby.count(), 3);
    }

    #[test]
    fn an_answer_reaches_only_a_member_that_asked_and_only_once() {
        let mut lobby = Lobby::new();
        let home = network("8.8.8.8");
        for (id, tx) in [(1, "tx-1"), (2, "tx-2"), (3, "tx-3")] {
            lobby.enter(&home, id, device("phone"), tx).unwrap();
        }
        assert_eq!(lobby.answer(&home, 2, 1), None, "nobody asked");
        assert_eq!(lobby.ask(&home, 1, 2), Some(&"tx-2"));
        assert_eq!(lobby.ask(&home, 1, 2), Some(&"tx-2"), "asking again");
        assert_eq!(lobby.answer(&home, 2, 3), None, "3 did not ask");
        assert_eq!(lobby.answer(&home, 3, 1), None, "1 asked 2, not 3");
        assert_eq!(lobby.answer(&home, 2, 1), Some(&"tx-1"), "a busy decline of the second ask");
        assert_eq!(lobby.answer(&home, 2, 1), Some(&"tx-1"), "the first ask's answer still gets through");
        assert_eq!(lobby.answer(&home, 2, 1), None, "both asks are used up");

        for _ in 0..OPEN_ASKS_MAX + 5 {
            lobby.ask(&home, 1, 2);
        }
        let answered = (0..).take_while(|_| lobby.answer(&home, 2, 1).is_some()).count();
        assert_eq!(answered, OPEN_ASKS_MAX, "open asks are capped");

        lobby.ask(&home, 3, 2);
        lobby.leave(&home, 3);
        lobby.enter(&home, 3, device("phone"), "tx-3b").unwrap();
        assert_eq!(lobby.answer(&home, 2, 3), None, "an ask ends with its asker's socket");
        assert_eq!(lobby.ask(&home, 9, 2), None, "an asker outside the group");
    }

    #[test]
    fn re_entering_an_id_renames_in_place() {
        let mut lobby = Lobby::new();
        let home = network("8.8.8.8");
        lobby.enter(&home, 1, device("phone"), "tx-1").unwrap();
        lobby.enter(&home, 2, device("laptop"), "tx-2").unwrap();
        assert_eq!(lobby.enter(&home, 1, device("new phone"), "tx-1b"), Ok(true));
        assert_eq!(lobby.enter(&home, 1, device("new phone"), "tx-1b"), Ok(false), "an unchanged hello");
        assert_eq!(lobby.count(), 2, "a rename adds nobody");
        assert_eq!(lobby.members(&home)[0], (1, &device("new phone"), &"tx-1"));
    }

    #[test]
    fn leave_removes_the_member_and_an_emptied_group() {
        let mut lobby = Lobby::new();
        let home = network("8.8.8.8");
        let elsewhere = network("1.1.1.1");
        lobby.enter(&home, 1, device("phone"), ()).unwrap();
        lobby.enter(&home, 2, device("laptop"), ()).unwrap();
        lobby.leave(&elsewhere, 1);
        assert_eq!(lobby.count(), 2, "a leave through another group does nothing");
        lobby.leave(&home, 1);
        assert_eq!(lobby.members(&home), vec![(2, &device("laptop"), &())]);
        assert_eq!(lobby.count(), 1);
        lobby.leave(&home, 9);
        assert_eq!(lobby.count(), 1, "unknown id");
        lobby.leave(&home, 2);
        assert_eq!(lobby.count(), 0);
        assert!(lobby.members(&home).is_empty(), "the emptied group is removed");
        lobby.leave(&home, 2);
        assert_eq!(lobby.count(), 0, "leaving twice does nothing");
    }

    #[test]
    fn a_full_group_refuses_one_more_but_still_takes_a_rename() {
        let mut lobby = Lobby::new();
        let home = network("8.8.8.8");
        for id in 0..GROUP_MAX as LobbyId {
            lobby.enter(&home, id, device("phone"), ()).unwrap();
        }
        assert_eq!(lobby.count(), GROUP_MAX as u64);
        assert_eq!(
            lobby.enter(&home, GROUP_MAX as LobbyId, device("late"), ()),
            Err(LobbyError::Full)
        );
        assert_eq!(lobby.count(), GROUP_MAX as u64);
        assert_eq!(lobby.enter(&home, 0, device("laptop"), ()), Ok(true));
        assert_eq!(
            lobby.members(&home)[0],
            (0, &device("laptop"), &()),
            "a rename in a full group"
        );
        assert_eq!(lobby.count(), GROUP_MAX as u64);
    }

    #[test]
    fn labels_are_trimmed_and_bounded() {
        assert_eq!(Device::new("", "phone"), None);
        assert_eq!(Device::new("   ", "phone"), None);
        assert_eq!(Device::new(&"a".repeat(LABEL_MAX + 1), "phone"), None);
        assert_eq!(Device::new("a\nb", "phone"), None);
        assert_eq!(Device::new("phone", "a\u{7}b"), None);
        assert!(Device::new(&"é".repeat(LABEL_MAX), "phone").is_some(), "char, not byte, count");
        assert!(Device::new(&"a".repeat(LABEL_MAX), "phone").is_some());
        assert_eq!(
            Device::new("  Alice  ", " laptop "),
            Some(Device {
                name: "Alice".to_owned(),
                device: "laptop".to_owned()
            })
        );
    }
}
