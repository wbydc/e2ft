//! Pure room state: accessKey -> a creator seat and a joiner seat. A seat whose socket
//! dropped stays "away" for the room's keep-alive and can be taken back with its token. No I/O; `T` is the
//! peer's send handle and time is passed in. Live rooms are counted per creator's client and IPv6 /48, to cap them.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv6Addr},
    time::{Duration, Instant},
};

use crate::signal::sockets::block;

pub type PeerId = u64;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Role {
    Creator = 0,
    Joiner = 1,
}

impl Role {
    fn other(self) -> Role {
        match self {
            Role::Creator => Role::Joiner,
            Role::Joiner => Role::Creator,
        }
    }
}

/// Rooms the server holds at once; a few hundred bytes each, so this bounds memory, not honest use.
pub const ROOMS_MAX: usize = 10_000;
/// Live rooms one client (an IPv4 address or an IPv6 /64) may have created by default, so one host cannot fill
/// ROOMS_MAX; `ROOMS_PER_CLIENT` in the environment overrides it.
pub const ROOMS_PER_CLIENT: u32 = 16;
/// Live rooms the /64s of one IPv6 /48 may have created together: a host with a /48 holds 65 536 /64s.
pub const ROOMS_PER_NETWORK: u32 = 256;

#[derive(Debug, PartialEq, Eq)]
pub enum RoomError {
    Exists,
    NotFound,
    Full,
    /// The server already holds ROOMS_MAX rooms.
    Busy,
    /// The creator's client or network already holds its share of rooms.
    TooMany,
}

impl RoomError {
    pub fn code(&self) -> &'static str {
        match self {
            RoomError::Exists => "exists",
            RoomError::NotFound => "not-found",
            RoomError::Full => "full",
            RoomError::Busy => "busy",
            RoomError::TooMany => "too-many",
        }
    }
}

enum Presence<T> {
    Here(PeerId, T),
    Away(Instant),
}

struct Seat<T> {
    token: String,
    presence: Presence<T>,
}

/// A counter of live created rooms, with its cap.
#[derive(Debug, PartialEq, Eq, Hash, Clone, Copy)]
enum Quota {
    Client(IpAddr),
    Network(Ipv6Addr),
}

impl Quota {
    /// The counters a room created from `address` counts under.
    fn of(address: IpAddr) -> [Option<Quota>; 2] {
        let client = block(address);
        let network = match client {
            IpAddr::V6(v6) => Some(Quota::Network(Ipv6Addr::from(u128::from(v6) & !(u128::MAX >> 48)))),
            IpAddr::V4(_) => None,
        };

        [Some(Quota::Client(client)), network]
    }

    fn cap(self, per_client: u32) -> u32 {
        match self {
            Quota::Client(_) => per_client,
            Quota::Network(_) => ROOMS_PER_NETWORK,
        }
    }
}

struct Room<T> {
    /// When the creator made it: the joiner seat must be taken before the room's wait runs out.
    created: Instant,
    /// Where the creator was, for the per-client counts.
    creator_address: IpAddr,
    keep_alive: Duration,
    /// Bumped on every (re)pairing, so pages can tell one pairing's signalling frames from the next.
    pairing: u64,
    seats: [Option<Seat<T>>; 2],
}

impl<T> Room<T> {
    fn seat_of(&self, peer: PeerId) -> Option<Role> {
        [Role::Creator, Role::Joiner]
            .into_iter()
            .find(|r| matches!(&self.seats[*r as usize], Some(Seat { presence: Presence::Here(id, _), .. }) if *id == peer))
    }

    fn here(&self, role: Role) -> Option<&T> {
        match &self.seats[role as usize] {
            Some(Seat {
                presence: Presence::Here(_, h),
                ..
            }) => Some(h),
            _ => None,
        }
    }

    fn away_left(&self, role: Role, now: Instant) -> Option<Duration> {
        match &self.seats[role as usize] {
            Some(Seat {
                presence: Presence::Away(until),
                ..
            }) => Some(until.saturating_duration_since(now)),
            _ => None,
        }
    }
}

/// Why a room was deleted.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum End {
    /// A peer sent leave.
    Leave = 0,
    /// A socket closed in a room whose keep-alive is Off.
    Closed = 1,
    /// An away seat's keep-alive ran out.
    Expired = 2,
    /// Nobody took the joiner seat in time.
    Unjoined = 3,
}

impl End {
    pub const ALL: [End; 4] = [End::Leave, End::Closed, End::Expired, End::Unjoined];

    pub fn code(self) -> &'static str {
        match self {
            End::Leave => "leave",
            End::Closed => "closed",
            End::Expired => "expired",
            End::Unjoined => "unjoined",
        }
    }
}

/// Counts for /metrics: no keys, tokens or handles.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub rooms: u64,
    pub here: u64,
    pub away: u64,
    /// Rooms deleted so far, indexed by `End`.
    pub ended: [u64; 4],
}

/// What a peer that just took a seat is told about the other seat.
#[derive(Debug, PartialEq, Eq)]
pub struct Seated<T> {
    pub pairing: u64,
    /// The other peer, connected now: both sides start WebRTC.
    pub other: Option<T>,
    /// The other seat is away for this much longer.
    pub other_away: Option<Duration>,
    /// The room's keep-alive, told to both sides.
    pub keep_alive: Duration,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Dropped<T> {
    /// The room is deleted (keep-alive Off, or the peer was not a member); notify the other peer if any.
    Gone(Option<T>),
    /// The seat is away until `until`; `sweep` ends the room then unless it came back.
    Away {
        until: Instant,
        other: Option<T>,
    },
}

pub struct Rooms<T> {
    rooms: HashMap<String, Room<T>>,
    /// Live rooms per Quota; a counter leaves with its last room.
    held: HashMap<Quota, u32>,
    per_client: u32,
    ended: [u64; 4],
}

impl<T: Clone> Rooms<T> {
    pub fn new(per_client: u32) -> Self {
        Rooms {
            rooms: HashMap::new(),
            held: HashMap::new(),
            per_client,
            ended: [0; 4],
        }
    }

    // Each argument is one fact about the new room; a struct for them would only move the list.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &mut self,
        key: &str,
        peer: PeerId,
        address: IpAddr,
        handle: T,
        token: &str,
        keep_alive: Duration,
        now: Instant,
    ) -> Result<(), RoomError> {
        if self.rooms.contains_key(key) {
            return Err(RoomError::Exists);
        }
        if self.rooms.len() >= ROOMS_MAX {
            return Err(RoomError::Busy);
        }
        let quotas = Quota::of(address).into_iter().flatten();
        if quotas.clone().any(|q| self.held.get(&q).is_some_and(|n| *n >= q.cap(self.per_client))) {
            return Err(RoomError::TooMany);
        }
        quotas.for_each(|q| *self.held.entry(q).or_default() += 1);

        let creator = Seat {
            token: token.to_owned(),
            presence: Presence::Here(peer, handle),
        };
        self.rooms.insert(
            key.to_owned(),
            Room {
                created: now,
                creator_address: address,
                keep_alive,
                pairing: 0,
                seats: [Some(creator), None],
            },
        );
        Ok(())
    }

    /// Takes the joiner seat, which only ever has one owner.
    pub fn join(
        &mut self,
        key: &str,
        peer: PeerId,
        handle: T,
        token: &str,
        now: Instant,
    ) -> Result<Seated<T>, RoomError> {
        let room = self.rooms.get_mut(key).ok_or(RoomError::NotFound)?;
        if room.seats[Role::Joiner as usize].is_some() {
            return Err(RoomError::Full);
        }
        room.seats[Role::Joiner as usize] = Some(Seat {
            token: token.to_owned(),
            presence: Presence::Here(peer, handle),
        });
        room.pairing += 1;
        Ok(Seated {
            pairing: room.pairing,
            other: room.here(Role::Creator).cloned(),
            other_away: room.away_left(Role::Creator, now),
            keep_alive: room.keep_alive,
        })
    }

    /// Takes a seat back with its token, from an away seat or from a socket that never noticed it died.
    /// Returns the displaced handle (to close) too.
    pub fn rejoin(
        &mut self,
        key: &str,
        role: Role,
        token: &str,
        peer: PeerId,
        handle: T,
        now: Instant,
    ) -> Result<(Seated<T>, Option<T>), RoomError> {
        let room = self.rooms.get_mut(key).ok_or(RoomError::NotFound)?;
        let seat = room.seats[role as usize]
            .as_mut()
            .filter(|s| s.token == token)
            .ok_or(RoomError::NotFound)?;
        let displaced = match std::mem::replace(&mut seat.presence, Presence::Here(peer, handle)) {
            Presence::Here(_, old) => Some(old),
            Presence::Away(_) => None,
        };
        room.pairing += 1;
        let seated = Seated {
            pairing: room.pairing,
            other: room.here(role.other()).cloned(),
            other_away: room.away_left(role.other(), now),
            keep_alive: room.keep_alive,
        };
        Ok((seated, displaced))
    }

    /// The other peer's handle, if `peer` holds a seat in room `key` and the other seat is connected.
    pub fn other(&self, key: &str, peer: PeerId) -> Option<&T> {
        let room = self.rooms.get(key)?;
        room.here(room.seat_of(peer)?.other())
    }

    /// `peer`'s socket closed without leaving: its seat waits for the keep-alive, or the room ends if that is 0.
    pub fn disconnect(&mut self, key: &str, peer: PeerId, now: Instant) -> Dropped<T> {
        let Some(room) = self.rooms.get_mut(key) else {
            return Dropped::Gone(None);
        };
        let Some(role) = room.seat_of(peer) else {
            return Dropped::Gone(None);
        };
        if room.keep_alive.is_zero() {
            let other = room.here(role.other()).cloned();
            self.end(key, End::Closed);
            return Dropped::Gone(other);
        }
        let until = now + room.keep_alive;
        room.seats[role as usize].as_mut().unwrap().presence = Presence::Away(until);
        Dropped::Away {
            until,
            other: room.here(role.other()).cloned(),
        }
    }

    /// Ends every room whose deadline passed by `now`: nobody took the joiner seat within `wait` of its creation, or
    /// an away seat's keep-alive ran out. Returns why each ended and the peer still connected in it, to tell.
    pub fn sweep(&mut self, now: Instant, wait: Duration) -> Vec<(End, T)> {
        let due: Vec<(String, End)> = self
            .rooms
            .iter()
            .filter_map(|(key, room)| {
                let away_ran_out = |seat: &Seat<T>| matches!(seat.presence, Presence::Away(until) if until <= now);
                let cause = if room.seats[Role::Joiner as usize].is_none() && room.created + wait <= now {
                    End::Unjoined
                } else if room.seats.iter().flatten().any(away_ran_out) {
                    End::Expired
                } else {
                    return None;
                };
                Some((key.clone(), cause))
            })
            .collect();

        due.into_iter()
            .filter_map(|(key, cause)| {
                let room = self.end(&key, cause)?;
                let here = room.here(Role::Creator).or(room.here(Role::Joiner)).cloned();
                here.map(|h| (cause, h))
            })
            .collect()
    }

    /// Deletes the room if `peer` holds a seat in it and returns the other peer's handle to notify.
    pub fn leave(&mut self, key: &str, peer: PeerId) -> Option<T> {
        let role = self.rooms.get(key)?.seat_of(peer)?;
        let room = self.end(key, End::Leave)?;
        room.here(role.other()).cloned()
    }

    fn end(&mut self, key: &str, cause: End) -> Option<Room<T>> {
        let room = self.rooms.remove(key)?;
        self.ended[cause as usize] += 1;
        for quota in Quota::of(room.creator_address).into_iter().flatten() {
            if let Some(count) = self.held.get_mut(&quota) {
                *count -= 1;
                if *count == 0 {
                    self.held.remove(&quota);
                }
            }
        }

        Some(room)
    }

    pub fn stats(&self) -> Stats {
        let mut s = Stats {
            rooms: self.rooms.len() as u64,
            ended: self.ended,
            ..Stats::default()
        };
        for seat in self.rooms.values().flat_map(|r| r.seats.iter().flatten()) {
            match seat.presence {
                Presence::Here(..) => s.here += 1,
                Presence::Away(_) => s.away += 1,
            }
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEEP: Duration = Duration::from_secs(300);
    const WAIT: Duration = Duration::from_secs(900);
    const HOME: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 7));

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    /// A different IPv4 client for each `i`.
    fn client(i: usize) -> IpAddr {
        IpAddr::V4(std::net::Ipv4Addr::from(0x0a00_0000 + i as u32))
    }

    fn now() -> Instant {
        Instant::now()
    }

    /// A room with a creator (peer 1) only, created at `t`.
    fn creator_room() -> (Rooms<&'static str>, Instant) {
        let mut rooms = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        rooms.create("k", 1, HOME, "a", "ta", KEEP, t).unwrap();

        (rooms, t)
    }

    /// A room with a creator (peer 1) and a joiner (peer 2), joined at `t`.
    fn joined_room() -> (Rooms<&'static str>, Instant) {
        let (mut rooms, t) = creator_room();
        rooms.join("k", 2, "b", "tb", t).unwrap();

        (rooms, t)
    }

    /// A unit-handle room with a creator (peer 1) only, created at `t`.
    fn creator_unit_room() -> (Rooms<()>, Instant) {
        let mut rooms = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        rooms.create("k", 1, HOME, (), "ta", KEEP, t).unwrap();

        (rooms, t)
    }

    /// A unit-handle room with a creator (peer 1) and a joiner (peer 2), joined at `t`.
    fn joined_unit_room() -> (Rooms<()>, Instant) {
        let (mut rooms, t) = creator_unit_room();
        rooms.join("k", 2, (), "tb", t).unwrap();

        (rooms, t)
    }

    /// A room key `k` left and made again by peer 5, with peer 2 of the old room still around.
    fn recreated_room() -> (Rooms<()>, Instant) {
        let mut rooms = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        rooms.create("k", 1, HOME, (), "ta", KEEP, t).unwrap();
        rooms.join("k", 2, (), "tb", t).unwrap();
        rooms.leave("k", 1);
        rooms.create("k", 5, HOME, (), "tz", KEEP, t).unwrap();

        (rooms, t)
    }

    /// A joined room whose joiner (peer 2) dropped at `t`, away until `t + KEEP`.
    fn away_joiner() -> (Rooms<&'static str>, Instant) {
        let (mut rooms, t) = joined_room();
        rooms.disconnect("k", 2, t);

        (rooms, t)
    }

    /// A joined room whose creator (peer 1) dropped at `t`, away until `t + KEEP`.
    fn away_creator() -> (Rooms<&'static str>, Instant) {
        let (mut rooms, t) = joined_room();
        rooms.disconnect("k", 1, t);

        (rooms, t)
    }

    /// A room with a creator (peer 1) only, whose socket dropped at `t`; nobody is left to tell.
    fn creator_away() -> (Rooms<&'static str>, Instant) {
        let (mut rooms, t) = creator_room();
        rooms.disconnect("k", 1, t);

        (rooms, t)
    }

    /// `ROOMS_MAX` rooms, so the next create is over the server's cap.
    fn rooms_at_max() -> Rooms<()> {
        let mut rooms = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        for i in 0..ROOMS_MAX {
            rooms.create(&format!("k{i}"), i as PeerId, client(i), (), "t", KEEP, t).unwrap();
        }

        rooms
    }

    /// A room with a taken joiner seat, and a second room still inside its wait.
    fn joined_and_later_rooms() -> (Rooms<&'static str>, Instant) {
        let mut rooms = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        rooms.create("joined", 1, HOME, "a", "ta", KEEP, t).unwrap();
        rooms.join("joined", 2, "b", "tb", t).unwrap();
        rooms.leave("joined", 2);
        rooms.create("joined", 3, HOME, "c", "tc", KEEP, t).unwrap();
        rooms.join("joined", 4, "d", "td", t).unwrap();
        rooms.create("later", 5, HOME, "e", "te", KEEP, t + Duration::from_secs(1)).unwrap();

        (rooms, t)
    }

    /// A joined room whose joiner dropped at `t + WAIT`, away until then plus the keep-alive.
    fn joiner_away_late() -> (Rooms<&'static str>, Instant) {
        let (mut rooms, t) = joined_room();
        rooms.disconnect("k", 2, t + WAIT);

        (rooms, t)
    }

    /// Two rooms and an away joiner seat, for the stats tests.
    fn stats_rooms() -> (Rooms<()>, Instant, Instant) {
        let mut rooms = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        rooms.create("a", 1, HOME, (), "t1", KEEP, t).unwrap();
        rooms.join("a", 2, (), "t2", t).unwrap();
        rooms.create("b", 3, HOME, (), "t3", Duration::ZERO, t).unwrap();
        let Dropped::Away { until, .. } = rooms.disconnect("a", 2, t) else {
            panic!("seat should be away")
        };

        (rooms, t, until)
    }

    /// `ROOMS_PER_CLIENT` rooms, all created by one IPv4 client.
    fn filled_for_one_client() -> Rooms<()> {
        let mut rooms = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        for i in 0..ROOMS_PER_CLIENT {
            rooms.create(&format!("k{i}"), 1, HOME, (), "t", KEEP, t).unwrap();
        }

        rooms
    }

    /// Rooms filling the IPv6 /64s 1 to `subnets` of one /48, `ROOMS_PER_CLIENT` rooms each.
    fn filled_ipv6_subnets(subnets: u32) -> Rooms<()> {
        let mut rooms = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        for subnet in 1..=subnets {
            for i in 0..ROOMS_PER_CLIENT {
                let address = ip(&format!("2001:db8:1:{subnet:x}::{i:x}"));
                rooms.create(&format!("r{subnet}-{i}"), 1, address, (), "t", KEEP, t).unwrap();
            }
        }

        rooms
    }

    /// A client's rooms filled with the `fill` rooms and the room `k` a cycle makes.
    fn ready_for_a_cycle() -> (Rooms<&'static str>, Instant) {
        let mut rooms = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        for i in 1..ROOMS_PER_CLIENT {
            // Created a second after `k`, so sweeping `k`'s wait spares them.
            rooms.create(&format!("fill{i}"), 9, HOME, "f", "t", KEEP, t + Duration::from_secs(1)).unwrap();
        }
        rooms.create("k", 1, HOME, "a", "ta", KEEP, t).unwrap();

        (rooms, t)
    }

    #[test]
    fn a_lone_creator_has_nobody_to_relay_to() {
        let (rooms, _) = creator_room();

        let other = rooms.other("k", 1);

        assert_eq!(other, None, "alone: nobody to relay to");
    }

    #[test]
    fn a_join_tells_the_joiner_about_the_creator() {
        let (mut rooms, t) = creator_room();

        let seated = rooms.join("k", 2, "b", "tb", t);

        assert_eq!(
            seated,
            Ok(Seated {
                pairing: 1,
                other: Some("a"),
                other_away: None,
                keep_alive: KEEP
            })
        );
    }

    #[test]
    fn the_creator_relays_to_the_joiner() {
        let (rooms, _) = joined_room();

        let other = rooms.other("k", 1);

        assert_eq!(other, Some(&"b"));
    }

    #[test]
    fn the_joiner_relays_to_the_creator() {
        let (rooms, _) = joined_room();

        let other = rooms.other("k", 2);

        assert_eq!(other, Some(&"a"));
    }

    #[test]
    fn a_leave_ends_the_room_and_tells_the_other_peer() {
        let (mut rooms, _) = joined_room();

        let told = rooms.leave("k", 2);
        let stats = rooms.stats();

        assert_eq!(told, Some("a"));
        assert_eq!(stats.rooms, 0, "room deleted when either peer leaves");
    }

    #[test]
    fn a_room_that_ended_cannot_be_joined() {
        let (mut rooms, t) = joined_room();
        rooms.leave("k", 2);

        let joined = rooms.join("k", 3, "c", "tc", t);

        assert_eq!(joined, Err(RoomError::NotFound), "room gone after leave");
    }

    #[test]
    fn a_duplicate_create_is_rejected() {
        let (mut rooms, _) = creator_unit_room();

        let created = rooms.create("k", 9, HOME, (), "tx", KEEP, now());

        assert_eq!(created, Err(RoomError::Exists));
    }

    #[test]
    fn a_third_peer_cannot_join() {
        let (mut rooms, t) = joined_unit_room();

        let joined = rooms.join("k", 3, (), "tc", t);
        let other = rooms.other("k", 3);

        assert_eq!(joined, Err(RoomError::Full));
        assert_eq!(other, None);
    }

    #[test]
    fn a_dropped_joiner_seat_waits_as_away() {
        let (mut rooms, t) = joined_unit_room();

        let dropped = rooms.disconnect("k", 2, t);

        assert!(matches!(dropped, Dropped::Away { .. }));
    }

    #[test]
    fn a_third_peer_cannot_take_an_away_joiner_seat() {
        let (mut rooms, t) = joined_unit_room();
        rooms.disconnect("k", 2, t);

        let joined = rooms.join("k", 3, (), "tc", t);

        assert_eq!(joined, Err(RoomError::Full));
    }

    #[test]
    fn a_peer_from_an_old_room_cannot_leave_the_new_one() {
        let (mut rooms, _) = recreated_room();

        let left = rooms.leave("k", 2);
        let live = rooms.stats().rooms;

        assert_eq!(left, None, "peer 2 was in the old room only");
        assert_eq!(live, 1);
    }

    #[test]
    fn a_socket_from_an_old_room_disconnects_as_gone() {
        let (mut rooms, t) = recreated_room();

        let dropped = rooms.disconnect("k", 2, t);

        assert_eq!(dropped, Dropped::Gone(None));
    }

    #[test]
    fn a_peer_from_an_old_room_has_nobody_to_relay_to() {
        let (rooms, _) = recreated_room();

        let other = rooms.other("k", 2);

        assert_eq!(other, None);
    }

    #[test]
    fn creator_leaving_alone_deletes_room() {
        let (mut rooms, _) = creator_unit_room();

        let left = rooms.leave("k", 1);
        let live = rooms.stats().rooms;

        assert_eq!(left, None);
        assert_eq!(live, 0);
    }

    #[test]
    fn keep_alive_off_deletes_the_room_on_disconnect() {
        let mut rooms = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        rooms.create("k", 1, HOME, "a", "ta", Duration::ZERO, now()).unwrap();
        rooms.join("k", 2, "b", "tb", t).unwrap();

        let dropped = rooms.disconnect("k", 2, t);
        let live = rooms.stats().rooms;

        assert_eq!(dropped, Dropped::Gone(Some("a")));
        assert_eq!(live, 0);
    }

    #[test]
    fn a_drop_holds_the_seat_for_the_keep_alive_and_tells_the_other() {
        let (mut rooms, t) = joined_room();

        let Dropped::Away { until, other } = rooms.disconnect("k", 2, t) else {
            panic!("not away")
        };

        assert_eq!((until, other), (t + KEEP, Some("a")));
    }

    #[test]
    fn an_away_seat_relays_to_nobody() {
        let (rooms, _) = away_joiner();

        let other = rooms.other("k", 1);

        assert_eq!(other, None, "nothing relayed to an away seat");
    }

    #[test]
    fn a_rejoin_with_the_wrong_token_is_refused() {
        let (mut rooms, t) = away_joiner();

        let rejoined = rooms.rejoin("k", Role::Joiner, "tX", 3, "b2", t);

        assert_eq!(rejoined, Err(RoomError::NotFound), "wrong token");
    }

    #[test]
    fn a_rejoin_with_the_other_seats_token_is_refused() {
        let (mut rooms, t) = away_joiner();

        let rejoined = rooms.rejoin("k", Role::Creator, "tb", 3, "b2", t);

        assert_eq!(rejoined, Err(RoomError::NotFound), "token of the other seat");
    }

    #[test]
    fn a_rejoin_with_its_token_restores_the_seat() {
        let (mut rooms, t) = away_joiner();

        let rejoined = rooms.rejoin("k", Role::Joiner, "tb", 3, "b2", t);

        assert_eq!(
            rejoined,
            Ok((
                Seated {
                    pairing: 2,
                    other: Some("a"),
                    other_away: None,
                    keep_alive: KEEP
                },
                None
            ))
        );
    }

    #[test]
    fn a_rejoined_seat_relays_to_the_other() {
        let (mut rooms, t) = away_joiner();
        rooms.rejoin("k", Role::Joiner, "tb", 3, "b2", t).unwrap();

        let other = rooms.other("k", 1);

        assert_eq!(other, Some(&"b2"));
    }

    #[test]
    fn a_rejoined_seat_leaves_no_expiry_to_sweep() {
        let (mut rooms, t) = away_joiner();
        rooms.rejoin("k", Role::Joiner, "tb", 3, "b2", t).unwrap();

        let swept = rooms.sweep(t + KEEP, WAIT);
        let live = rooms.stats().rooms;

        assert_eq!(swept, vec![], "the old absence's deadline does nothing");
        assert_eq!(live, 1);
    }

    #[test]
    fn a_dropped_creator_leaves_no_one_to_tell() {
        let (mut rooms, t) = creator_room();

        let dropped = rooms.disconnect("k", 1, t);

        assert!(matches!(dropped, Dropped::Away { other: None, .. }));
    }

    #[test]
    fn a_seat_is_not_swept_before_its_keep_alive_runs_out() {
        let (mut rooms, t) = away_creator();

        let swept = rooms.sweep(t + KEEP - Duration::from_millis(1), WAIT);

        assert_eq!(swept, vec![], "not yet");
    }

    #[test]
    fn a_seat_whose_keep_alive_ran_out_ends_the_room() {
        let (mut rooms, t) = away_creator();

        let swept = rooms.sweep(t + KEEP, WAIT);
        let live = rooms.stats().rooms;

        assert_eq!(swept, vec![(End::Expired, "b")], "the waiting joiner is told");
        assert_eq!(live, 0);
    }

    #[test]
    fn a_late_rejoin_after_the_keep_alive_is_refused() {
        let (mut rooms, t) = away_creator();
        rooms.sweep(t + KEEP, WAIT);

        let rejoined = rooms.rejoin("k", Role::Creator, "ta", 3, "a2", t);

        assert_eq!(rejoined, Err(RoomError::NotFound));
    }

    #[test]
    fn a_rejoin_displaces_the_socket_still_thought_open() {
        let (mut rooms, t) = joined_room();

        let (seated, displaced) = rooms.rejoin("k", Role::Creator, "ta", 3, "a2", t).unwrap();

        assert_eq!((seated.other, displaced), (Some("b"), Some("a")));
    }

    #[test]
    fn a_displaced_sockets_close_changes_nothing() {
        let (mut rooms, t) = joined_room();
        rooms.rejoin("k", Role::Creator, "ta", 3, "a2", t).unwrap();

        let dropped = rooms.disconnect("k", 1, t);
        let other = rooms.other("k", 2);
        let live = rooms.stats().rooms;

        assert_eq!(dropped, Dropped::Gone(None), "the displaced socket closing changes nothing");
        assert_eq!(other, Some(&"a2"));
        assert_eq!(live, 1);
    }

    #[test]
    fn a_joiner_is_told_how_long_the_away_creator_waits() {
        let (mut rooms, t) = creator_away();

        let seated = rooms.join("k", 2, "b", "tb", t + Duration::from_secs(100)).unwrap();

        assert_eq!((seated.other, seated.other_away), (None, Some(Duration::from_secs(200))));
    }

    #[test]
    fn the_creator_rejoining_sees_the_joiner() {
        let (mut rooms, t) = creator_away();
        rooms.join("k", 2, "b", "tb", t + Duration::from_secs(100)).unwrap();

        let (back, _) = rooms.rejoin("k", Role::Creator, "ta", 3, "a2", t).unwrap();

        assert_eq!((back.pairing, back.other), (2, Some("b")));
    }

    #[test]
    fn creating_past_rooms_max_is_busy() {
        let mut rooms = rooms_at_max();

        let created = rooms.create("late", 0, HOME, (), "t", KEEP, now());

        assert_eq!(created, Err(RoomError::Busy));
    }

    #[test]
    fn a_room_ending_frees_a_slot_at_rooms_max() {
        let mut rooms = rooms_at_max();
        rooms.leave("k0", 0);

        let created = rooms.create("late", 0, HOME, (), "t", KEEP, now());

        assert_eq!(created, Ok(()));
    }

    #[test]
    fn an_unjoined_room_is_not_swept_before_its_wait_runs_out() {
        let (mut rooms, t) = creator_room();

        let swept = rooms.sweep(t + WAIT - Duration::from_millis(1), WAIT);

        assert_eq!(swept, vec![], "not yet");
    }

    #[test]
    fn an_unjoined_room_ends_when_its_wait_runs_out() {
        let (mut rooms, t) = creator_room();

        let swept = rooms.sweep(t + WAIT, WAIT);
        let stats = rooms.stats();

        assert_eq!(swept, vec![(End::Unjoined, "a")]);
        assert_eq!(stats.rooms, 0);
        assert_eq!(stats.ended[End::Unjoined as usize], 1);
    }

    #[test]
    fn a_room_swept_as_unjoined_cannot_be_joined() {
        let (mut rooms, t) = creator_room();
        rooms.sweep(t + WAIT, WAIT);

        let joined = rooms.join("k", 2, "b", "tb", t);

        assert_eq!(joined, Err(RoomError::NotFound));
    }

    #[test]
    fn the_wait_spares_a_joined_room_and_a_room_created_later() {
        let (mut rooms, t) = joined_and_later_rooms();

        let swept = rooms.sweep(t + WAIT, WAIT);
        let live = rooms.stats().rooms;

        assert_eq!(swept, vec![], "a taken joiner seat, and a room still in its wait");
        assert_eq!(live, 2);
    }

    #[test]
    fn the_room_created_later_ends_when_its_own_wait_runs_out() {
        let (mut rooms, t) = joined_and_later_rooms();
        rooms.sweep(t + WAIT, WAIT);

        let swept = rooms.sweep(t + WAIT + Duration::from_secs(1), WAIT);

        assert_eq!(swept, vec![(End::Unjoined, "e")]);
    }

    #[test]
    fn an_away_joiner_still_holds_its_seat() {
        let (mut rooms, t) = joiner_away_late();

        let swept = rooms.sweep(t + WAIT, WAIT);

        assert_eq!(swept, vec![], "an away joiner still holds its seat");
    }

    #[test]
    fn a_rejoined_joiner_is_not_swept() {
        let (mut rooms, t) = joiner_away_late();
        rooms.rejoin("k", Role::Joiner, "tb", 3, "b2", t + WAIT).unwrap();

        let swept = rooms.sweep(t + WAIT + KEEP, WAIT);
        let live = rooms.stats().rooms;

        assert_eq!(swept, vec![]);
        assert_eq!(live, 1);
    }

    #[test]
    fn stats_count_live_seats_and_away_seats() {
        let (rooms, _, _) = stats_rooms();

        let stats = rooms.stats();

        assert_eq!(
            stats,
            Stats {
                rooms: 2,
                here: 2,
                away: 1,
                ended: [0, 0, 0, 0]
            }
        );
    }

    #[test]
    fn stats_count_each_way_a_room_ends() {
        let (mut rooms, t, until) = stats_rooms();
        rooms.disconnect("b", 3, t);
        rooms.sweep(until, WAIT);
        rooms.create("c", 4, HOME, (), "t4", KEEP, now()).unwrap();
        rooms.leave("c", 4);

        let stats = rooms.stats();

        assert_eq!(
            stats,
            Stats {
                rooms: 0,
                here: 0,
                away: 0,
                ended: [1, 1, 1, 0]
            }
        );
    }

    #[test]
    fn a_second_leave_of_a_gone_room_counts_nothing() {
        let (mut rooms, _, _) = stats_rooms();
        rooms.create("c", 4, HOME, (), "t4", KEEP, now()).unwrap();
        rooms.leave("c", 4);

        let left = rooms.leave("c", 4);

        assert_eq!(left, None, "a second leave of a gone room counts nothing");
    }

    #[test]
    fn a_client_cannot_create_more_than_its_share() {
        let mut rooms = filled_for_one_client();

        let created = rooms.create("late", 1, HOME, (), "t", KEEP, now());

        assert_eq!(created, Err(RoomError::TooMany));
    }

    #[test]
    fn another_client_can_still_create() {
        let mut rooms = filled_for_one_client();

        let created = rooms.create("other", 2, ip("203.0.113.8"), (), "t", KEEP, now());

        assert_eq!(created, Ok(()));
    }

    #[test]
    fn joining_someone_elses_room_is_not_capped() {
        let mut rooms = filled_for_one_client();
        let t = now();

        let joined = rooms.join("k0", 3, (), "tj", t);

        assert_eq!(joined.map(|seated| seated.pairing), Ok(1), "joining someone's room is not capped");
    }

    #[test]
    fn ipv6_rooms_count_by_the_64() {
        let mut rooms = filled_ipv6_subnets(1);

        let created = rooms.create("a", 1, ip("2001:db8:1:1:ffff::1"), (), "t", KEEP, now());

        assert_eq!(created, Err(RoomError::TooMany), "same /64");
    }

    #[test]
    fn ipv6_rooms_count_by_the_48() {
        let mut rooms = filled_ipv6_subnets(ROOMS_PER_NETWORK / ROOMS_PER_CLIENT);

        let created = rooms.create("b", 1, ip("2001:db8:1:ffff::1"), (), "t", KEEP, now());

        assert_eq!(created, Err(RoomError::TooMany), "same /48");
    }

    #[test]
    fn the_next_48_is_not_capped() {
        let mut rooms = filled_ipv6_subnets(ROOMS_PER_NETWORK / ROOMS_PER_CLIENT);

        let created = rooms.create("c", 1, ip("2001:db8:2::1"), (), "t", KEEP, now());

        assert_eq!(created, Ok(()), "next /48");
    }

    #[test]
    fn a_room_ending_frees_the_48() {
        let mut rooms = filled_ipv6_subnets(ROOMS_PER_NETWORK / ROOMS_PER_CLIENT);
        rooms.leave("r1-0", 1);

        let created = rooms.create("b", 1, ip("2001:db8:1:ffff::1"), (), "t", KEEP, now());

        assert_eq!(created, Ok(()), "a room ended frees the /48");
    }

    #[test]
    fn a_leave_frees_the_rooms_count() {
        let (mut rooms, t) = ready_for_a_cycle();
        let blocked = rooms.create("x", 1, HOME, "a", "tx", KEEP, t);

        rooms.leave("k", 1);
        let live = rooms.stats().rooms;

        assert_eq!(blocked, Err(RoomError::TooMany));
        assert_eq!(live as u32, ROOMS_PER_CLIENT - 1);
    }

    #[test]
    fn a_swept_wait_frees_the_rooms_count() {
        let (mut rooms, t) = ready_for_a_cycle();
        let blocked = rooms.create("x", 1, HOME, "a", "tx", KEEP, t);

        rooms.sweep(t + WAIT, WAIT);
        let live = rooms.stats().rooms;

        assert_eq!(blocked, Err(RoomError::TooMany));
        assert_eq!(live as u32, ROOMS_PER_CLIENT - 1);
    }

    #[test]
    fn an_expired_keep_alive_frees_the_rooms_count() {
        let (mut rooms, t) = ready_for_a_cycle();
        let blocked = rooms.create("x", 1, HOME, "a", "tx", KEEP, t);
        rooms.join("k", 2, "b", "tb", t).unwrap();
        let Dropped::Away { until, .. } = rooms.disconnect("k", 2, t) else {
            panic!("not away")
        };

        rooms.sweep(until, WAIT);
        let live = rooms.stats().rooms;

        assert_eq!(blocked, Err(RoomError::TooMany));
        assert_eq!(live as u32, ROOMS_PER_CLIENT - 1);
    }

    #[test]
    fn a_joiner_leaving_frees_the_rooms_count() {
        let (mut rooms, t) = ready_for_a_cycle();
        let blocked = rooms.create("x", 1, HOME, "a", "tx", KEEP, t);
        rooms.join("k", 2, "b", "tb", t).unwrap();

        rooms.leave("k", 2);
        let live = rooms.stats().rooms;

        assert_eq!(blocked, Err(RoomError::TooMany));
        assert_eq!(live as u32, ROOMS_PER_CLIENT - 1);
    }

    // The ended totals count each way of ending a room once, so only the four cycles together make them meaningful.
    #[test]
    fn the_ended_totals_count_each_way_a_room_ends_once() {
        let mut rooms = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        for i in 1..ROOMS_PER_CLIENT {
            // Created a second after `k`, so sweeping `k`'s wait spares them.
            rooms.create(&format!("fill{i}"), 9, HOME, "f", "t", KEEP, t + Duration::from_secs(1)).unwrap();
        }
        let cycle = |rooms: &mut Rooms<&'static str>, end: &dyn Fn(&mut Rooms<&'static str>)| {
            rooms.create("k", 1, HOME, "a", "ta", KEEP, t).unwrap();
            end(rooms);
        };

        cycle(&mut rooms, &|rooms| {
            rooms.leave("k", 1);
        });
        cycle(&mut rooms, &|rooms| {
            rooms.sweep(t + WAIT, WAIT);
        });
        cycle(&mut rooms, &|rooms| {
            rooms.join("k", 2, "b", "tb", t).unwrap();
            let Dropped::Away { until, .. } = rooms.disconnect("k", 2, t) else {
                panic!("not away")
            };
            rooms.sweep(until, WAIT);
        });
        cycle(&mut rooms, &|rooms| {
            rooms.join("k", 2, "b", "tb", t).unwrap();
            rooms.leave("k", 2);
        });
        rooms.create("off", 1, HOME, "a", "ta", Duration::ZERO, t).unwrap();
        rooms.disconnect("off", 1, t);

        let created = rooms.create("k", 1, HOME, "a", "ta", KEEP, t);
        let ended = rooms.stats().ended;
        let held = rooms.held.len();

        assert_eq!(ended, [2, 1, 1, 1]);
        assert_eq!(created, Ok(()), "a closed room freed its count");
        assert_eq!(held, 1);
    }
}
