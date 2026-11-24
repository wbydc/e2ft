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

    fn three_members() -> (Lobby<&'static str>, Network, Network) {
        let mut lobby = Lobby::new();
        let home = network("8.8.8.8");
        let elsewhere = network("1.1.1.1");
        lobby.enter(&home, 2, device("phone"), "tx-2").unwrap();
        lobby.enter(&home, 1, device("laptop"), "tx-1").unwrap();
        lobby.enter(&elsewhere, 3, device("tablet"), "tx-3").unwrap();

        (lobby, home, elsewhere)
    }

    fn three_in_home() -> (Lobby<&'static str>, Network) {
        let mut lobby = Lobby::new();
        let home = network("8.8.8.8");
        for (id, tx) in [(1, "tx-1"), (2, "tx-2"), (3, "tx-3")] {
            lobby.enter(&home, id, device("phone"), tx).unwrap();
        }

        (lobby, home)
    }

    fn renamed() -> (Lobby<&'static str>, Network) {
        let mut lobby = Lobby::new();
        let home = network("8.8.8.8");
        lobby.enter(&home, 1, device("phone"), "tx-1").unwrap();
        lobby.enter(&home, 2, device("laptop"), "tx-2").unwrap();
        lobby.enter(&home, 1, device("new phone"), "tx-1b").unwrap();

        (lobby, home)
    }

    fn two_members() -> (Lobby<()>, Network, Network) {
        let mut lobby = Lobby::new();
        let home = network("8.8.8.8");
        let elsewhere = network("1.1.1.1");
        lobby.enter(&home, 1, device("phone"), ()).unwrap();
        lobby.enter(&home, 2, device("laptop"), ()).unwrap();

        (lobby, home, elsewhere)
    }

    fn full_group() -> (Lobby<()>, Network) {
        let mut lobby = Lobby::new();
        let home = network("8.8.8.8");
        for id in 0..GROUP_MAX as LobbyId {
            lobby.enter(&home, id, device("phone"), ()).unwrap();
        }

        (lobby, home)
    }

    #[test]
    fn the_same_address_gives_the_same_network() {
        let same = network("8.8.8.8") == network("8.8.8.8");

        assert!(same, "same address");
    }

    #[test]
    fn a_different_address_gives_a_different_network() {
        let different = network("8.8.8.8") != network("8.8.4.4");

        assert!(different, "different address");
    }

    #[test]
    fn a_different_key_gives_a_different_network() {
        let address: IpAddr = "8.8.8.8".parse().unwrap();
        let other_key = [8; 32];

        let same = Network::new(&KEY, address, true).unwrap();
        let other = Network::new(&other_key, address, true).unwrap();

        assert!(same != other, "a different key gives a different network");
    }

    #[test]
    fn ipv6_addresses_in_one_64_group_together() {
        let same = network("2606:4700:4700::1") == network("2606:4700:4700::2222");

        assert!(same, "one /64");
    }

    #[test]
    fn ipv6_addresses_in_different_64s_do_not_group() {
        let different = network("2606:4700:4700::1") != network("2606:4700:4701::1");

        assert!(different, "other /64");
    }

    #[test]
    fn a_mapped_ipv6_address_is_its_ipv4() {
        let mapped = network("::ffff:8.8.8.8") == network("8.8.8.8");

        assert!(mapped, "mapped is IPv4");
    }

    #[test]
    fn non_public_addresses_never_form_a_group() {
        let addresses = [
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
        ];

        let created: Vec<(IpAddr, Option<Network>, Option<Network>)> = addresses
            .iter()
            .map(|text| {
                let address: IpAddr = text.parse().expect("address");
                (address, Network::new(&KEY, address, true), Network::new(&KEY, address, false))
            })
            .collect();
        let direct: Vec<IpAddr> = created.iter().filter(|(_, direct, _)| direct.is_some()).map(|row| row.0).collect();
        let header: Vec<IpAddr> = created.iter().filter(|(_, _, header)| header.is_some()).map(|row| row.0).collect();

        assert_eq!(direct, Vec::<IpAddr>::new(), "formed a group direct");
        assert_eq!(header, Vec::<IpAddr>::new(), "formed a group from a header");
    }

    #[test]
    fn loopback_forms_a_group_only_from_the_socket_address() {
        let addresses = ["127.0.0.1", "::1"];

        let created: Vec<(IpAddr, Option<Network>, Option<Network>)> = addresses
            .iter()
            .map(|text| {
                let address: IpAddr = text.parse().expect("address");
                (address, Network::new(&KEY, address, true), Network::new(&KEY, address, false))
            })
            .collect();
        let direct: Vec<IpAddr> = created.iter().filter(|(_, direct, _)| direct.is_none()).map(|row| row.0).collect();
        let header: Vec<IpAddr> = created.iter().filter(|(_, _, header)| header.is_some()).map(|row| row.0).collect();

        assert_eq!(direct, Vec::<IpAddr>::new(), "no group direct");
        assert_eq!(header, Vec::<IpAddr>::new(), "formed a group from a header");
    }

    #[test]
    fn members_lists_one_group_in_enter_order() {
        let (lobby, home, _) = three_members();

        let members = lobby.members(&home);

        assert_eq!(
            members,
            vec![(2, &device("phone"), &"tx-2"), (1, &device("laptop"), &"tx-1")]
        );
    }

    #[test]
    fn an_ask_to_a_member_of_another_group_reaches_nobody() {
        let (mut lobby, home, _) = three_members();

        let asked = lobby.ask(&home, 1, 3);

        assert_eq!(asked, None, "a member of another group");
    }

    #[test]
    fn an_ask_to_itself_reaches_nobody() {
        let (mut lobby, _, elsewhere) = three_members();

        let asked = lobby.ask(&elsewhere, 3, 3);

        assert_eq!(asked, None, "itself");
    }

    #[test]
    fn an_ask_reaches_the_member_asked() {
        let (mut lobby, home, _) = three_members();

        let asked = lobby.ask(&home, 1, 2);

        assert_eq!(asked, Some(&"tx-2"));
    }

    #[test]
    fn count_counts_members_over_all_groups() {
        let (lobby, _, _) = three_members();

        let count = lobby.count();

        assert_eq!(count, 3);
    }

    #[test]
    fn an_answer_before_an_ask_reaches_nobody() {
        let (mut lobby, home) = three_in_home();

        let answer = lobby.answer(&home, 2, 1);

        assert_eq!(answer, None, "nobody asked");
    }

    #[test]
    fn an_ask_returns_the_asked_members_handle() {
        let (mut lobby, home) = three_in_home();

        let ask = lobby.ask(&home, 1, 2);

        assert_eq!(ask, Some(&"tx-2"));
    }

    #[test]
    fn asking_again_returns_the_same_handle() {
        let (mut lobby, home) = three_in_home();
        let _ = lobby.ask(&home, 1, 2);

        let ask = lobby.ask(&home, 1, 2);

        assert_eq!(ask, Some(&"tx-2"), "asking again");
    }

    #[test]
    fn an_answer_from_a_member_that_was_not_asked_reaches_nobody() {
        let (mut lobby, home) = three_in_home();
        let _ = lobby.ask(&home, 1, 2);

        let answer = lobby.answer(&home, 2, 3);

        assert_eq!(answer, None, "3 did not ask");
    }

    #[test]
    fn an_answer_to_an_asker_who_asked_someone_else_reaches_nobody() {
        let (mut lobby, home) = three_in_home();
        let _ = lobby.ask(&home, 1, 2);

        let answer = lobby.answer(&home, 3, 1);

        assert_eq!(answer, None, "1 asked 2, not 3");
    }

    #[test]
    fn a_busy_member_answers_the_second_ask() {
        let (mut lobby, home) = three_in_home();
        let _ = lobby.ask(&home, 1, 2);
        let _ = lobby.ask(&home, 1, 2);

        let answer = lobby.answer(&home, 2, 1);

        assert_eq!(answer, Some(&"tx-1"), "a busy decline of the second ask");
    }

    #[test]
    fn the_first_asks_answer_still_gets_through() {
        let (mut lobby, home) = three_in_home();
        let _ = lobby.ask(&home, 1, 2);
        let _ = lobby.ask(&home, 1, 2);
        let _ = lobby.answer(&home, 2, 1);

        let answer = lobby.answer(&home, 2, 1);

        assert_eq!(answer, Some(&"tx-1"), "the first ask's answer still gets through");
    }

    #[test]
    fn both_asks_are_used_up_by_the_answers() {
        let (mut lobby, home) = three_in_home();
        let _ = lobby.ask(&home, 1, 2);
        let _ = lobby.ask(&home, 1, 2);
        let _ = lobby.answer(&home, 2, 1);
        let _ = lobby.answer(&home, 2, 1);

        let answer = lobby.answer(&home, 2, 1);

        assert_eq!(answer, None, "both asks are used up");
    }

    #[test]
    fn open_asks_are_capped() {
        let (mut lobby, home) = three_in_home();
        for _ in 0..OPEN_ASKS_MAX + 5 {
            let _ = lobby.ask(&home, 1, 2);
        }

        let answered = (0..).take_while(|_| lobby.answer(&home, 2, 1).is_some()).count();

        assert_eq!(answered, OPEN_ASKS_MAX, "open asks are capped");
    }

    #[test]
    fn an_ask_ends_with_its_askers_socket() {
        let (mut lobby, home) = three_in_home();
        let _ = lobby.ask(&home, 3, 2);
        lobby.leave(&home, 3);
        lobby.enter(&home, 3, device("phone"), "tx-3b").unwrap();

        let answer = lobby.answer(&home, 2, 3);

        assert_eq!(answer, None, "an ask ends with its asker's socket");
    }

    #[test]
    fn an_asker_outside_the_group_gets_no_handle() {
        let (mut lobby, home) = three_in_home();

        let ask = lobby.ask(&home, 9, 2);

        assert_eq!(ask, None, "an asker outside the group");
    }

    #[test]
    fn re_entering_an_id_replaces_its_device() {
        let mut lobby = Lobby::new();
        let home = network("8.8.8.8");
        lobby.enter(&home, 1, device("phone"), "tx-1").unwrap();
        lobby.enter(&home, 2, device("laptop"), "tx-2").unwrap();

        let changed = lobby.enter(&home, 1, device("new phone"), "tx-1b");

        assert_eq!(changed, Ok(true));
    }

    #[test]
    fn a_hello_with_the_same_device_changes_nothing() {
        let (mut lobby, home) = renamed();

        let changed = lobby.enter(&home, 1, device("new phone"), "tx-1b");

        assert_eq!(changed, Ok(false), "an unchanged hello");
    }

    #[test]
    fn a_rename_adds_nobody() {
        let (lobby, _) = renamed();

        let count = lobby.count();

        assert_eq!(count, 2, "a rename adds nobody");
    }

    #[test]
    fn a_renamed_member_keeps_its_position() {
        let (lobby, home) = renamed();

        let members = lobby.members(&home);

        assert_eq!(members[0], (1, &device("new phone"), &"tx-1"));
    }

    #[test]
    fn a_leave_through_another_group_removes_nobody() {
        let (mut lobby, _, elsewhere) = two_members();

        lobby.leave(&elsewhere, 1);

        let count = lobby.count();

        assert_eq!(count, 2, "a leave through another group does nothing");
    }

    #[test]
    fn a_leave_removes_the_member() {
        let (mut lobby, home, _) = two_members();

        lobby.leave(&home, 1);

        let members = lobby.members(&home);
        let count = lobby.count();

        assert_eq!(members, vec![(2, &device("laptop"), &())]);
        assert_eq!(count, 1);
    }

    #[test]
    fn an_unknown_id_leaves_everyone() {
        let (mut lobby, home, _) = two_members();
        lobby.leave(&home, 1);

        lobby.leave(&home, 9);

        let count = lobby.count();

        assert_eq!(count, 1, "unknown id");
    }

    #[test]
    fn the_last_leave_removes_the_group() {
        let (mut lobby, home, _) = two_members();
        lobby.leave(&home, 1);

        lobby.leave(&home, 2);

        let count = lobby.count();
        let members = lobby.members(&home);

        assert_eq!(count, 0);
        assert!(members.is_empty(), "the emptied group is removed");
    }

    #[test]
    fn leaving_twice_does_nothing() {
        let (mut lobby, home, _) = two_members();
        lobby.leave(&home, 1);
        lobby.leave(&home, 2);

        lobby.leave(&home, 2);

        let count = lobby.count();

        assert_eq!(count, 0, "leaving twice does nothing");
    }

    #[test]
    fn a_full_group_refuses_one_more() {
        let (mut lobby, home) = full_group();

        let reserved = lobby.enter(&home, GROUP_MAX as LobbyId, device("late"), ());

        let count = lobby.count();

        assert_eq!(reserved, Err(LobbyError::Full));
        assert_eq!(count, GROUP_MAX as u64);
    }

    #[test]
    fn a_full_group_still_takes_a_rename() {
        let (mut lobby, home) = full_group();

        let renamed = lobby.enter(&home, 0, device("laptop"), ());

        let members = lobby.members(&home);
        let count = lobby.count();

        assert_eq!(renamed, Ok(true));
        assert_eq!(members[0], (0, &device("laptop"), &()), "a rename in a full group");
        assert_eq!(count, GROUP_MAX as u64);
    }

    #[test]
    fn a_label_must_be_present_short_and_plain() {
        let long = "a".repeat(LABEL_MAX + 1);
        let cases = [
            ("", "phone"),
            ("   ", "phone"),
            (long.as_str(), "phone"),
            ("a\nb", "phone"),
            ("phone", "a\u{7}b"),
        ];

        let created: Vec<Option<Device>> =
            cases.iter().map(|(name, device)| Device::new(name, device)).collect();

        assert_eq!(created, [None, None, None, None, None], "{cases:?}");
    }

    #[test]
    fn labels_count_chars_not_bytes() {
        let name = "é".repeat(LABEL_MAX);

        let created = Device::new(&name, "phone");

        assert!(created.is_some(), "char, not byte, count");
    }

    #[test]
    fn a_label_of_the_maximum_length_is_allowed() {
        let name = "a".repeat(LABEL_MAX);

        let created = Device::new(&name, "phone");

        assert!(created.is_some());
    }

    #[test]
    fn labels_are_trimmed() {
        let created = Device::new("  Alice  ", " laptop ");

        assert_eq!(
            created,
            Some(Device {
                name: "Alice".to_owned(),
                device: "laptop".to_owned()
            })
        );
    }
}
