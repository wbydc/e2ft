//! Pure room state: accessKey -> a creator seat and a joiner seat. A seat whose socket
//! dropped stays "away" for the room's keep-alive and can be taken back with its token. No I/O; `T` is the
//! peer's send handle and time is passed in. Live rooms are counted per creator's client and IPv6 /48, to cap them.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv6Addr},
    time::{Duration, Instant},
};

use crate::sockets::block;

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

    #[test]
    fn create_join_relay_leave() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        r.create("k", 1, HOME, "a", "ta", KEEP, now()).unwrap();
        assert_eq!(r.other("k", 1), None, "alone: nobody to relay to");
        assert_eq!(
            r.join("k", 2, "b", "tb", t),
            Ok(Seated {
                pairing: 1,
                other: Some("a"),
                other_away: None,
                keep_alive: KEEP
            })
        );
        assert_eq!(r.other("k", 1), Some(&"b"));
        assert_eq!(r.other("k", 2), Some(&"a"));
        assert_eq!(r.leave("k", 2), Some("a"));
        assert_eq!(r.stats().rooms, 0, "room deleted when either peer leaves");
        assert_eq!(
            r.join("k", 3, "c", "tc", t),
            Err(RoomError::NotFound),
            "room gone after leave"
        );
    }

    #[test]
    fn third_peer_and_duplicate_create_rejected() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        r.create("k", 1, HOME, (), "ta", KEEP, now()).unwrap();
        assert_eq!(r.create("k", 9, HOME, (), "tx", KEEP, now()), Err(RoomError::Exists));
        r.join("k", 2, (), "tb", t).unwrap();
        assert_eq!(r.join("k", 3, (), "tc", t), Err(RoomError::Full));
        assert_eq!(r.other("k", 3), None);
    }

    #[test]
    fn an_away_joiner_seat_cannot_be_joined_by_someone_else() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        r.create("k", 1, HOME, (), "ta", KEEP, now()).unwrap();
        r.join("k", 2, (), "tb", t).unwrap();
        assert!(matches!(r.disconnect("k", 2, t), Dropped::Away { .. }));
        assert_eq!(r.join("k", 3, (), "tc", t), Err(RoomError::Full));
    }

    #[test]
    fn stale_peer_cannot_touch_a_new_room_with_the_same_key() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        r.create("k", 1, HOME, (), "ta", KEEP, now()).unwrap();
        r.join("k", 2, (), "tb", t).unwrap();
        r.leave("k", 1);
        r.create("k", 5, HOME, (), "tz", KEEP, now()).unwrap();
        assert_eq!(r.leave("k", 2), None, "peer 2 was in the old room only");
        assert_eq!(r.disconnect("k", 2, t), Dropped::Gone(None));
        assert_eq!(r.other("k", 2), None);
        assert_eq!(r.stats().rooms, 1);
    }

    #[test]
    fn creator_leaving_alone_deletes_room() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        r.create("k", 1, HOME, (), "ta", KEEP, now()).unwrap();
        assert_eq!(r.leave("k", 1), None);
        assert_eq!(r.stats().rooms, 0);
    }

    #[test]
    fn keep_alive_off_deletes_the_room_on_disconnect() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        r.create("k", 1, HOME, "a", "ta", Duration::ZERO, now()).unwrap();
        r.join("k", 2, "b", "tb", t).unwrap();
        assert_eq!(r.disconnect("k", 2, t), Dropped::Gone(Some("a")));
        assert_eq!(r.stats().rooms, 0);
    }

    #[test]
    fn a_dropped_peer_rejoins_with_its_token_within_the_keep_alive() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        r.create("k", 1, HOME, "a", "ta", KEEP, now()).unwrap();
        r.join("k", 2, "b", "tb", t).unwrap();
        let Dropped::Away { until, other } = r.disconnect("k", 2, t) else {
            panic!("not away")
        };
        assert_eq!((until, other), (t + KEEP, Some("a")));
        assert_eq!(r.other("k", 1), None, "nothing relayed to an away seat");
        assert_eq!(
            r.rejoin("k", Role::Joiner, "tX", 3, "b2", t),
            Err(RoomError::NotFound),
            "wrong token"
        );
        assert_eq!(
            r.rejoin("k", Role::Creator, "tb", 3, "b2", t),
            Err(RoomError::NotFound),
            "token of the other seat"
        );
        assert_eq!(
            r.rejoin("k", Role::Joiner, "tb", 3, "b2", t),
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
        assert_eq!(r.other("k", 1), Some(&"b2"));
        assert_eq!(r.sweep(until, WAIT), vec![], "the old absence's deadline does nothing");
        assert_eq!(r.stats().rooms, 1);
    }

    #[test]
    fn the_keep_alive_running_out_deletes_the_room_and_refuses_a_late_rejoin() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        r.create("k", 1, HOME, "a", "ta", KEEP, now()).unwrap();
        r.join("k", 2, "b", "tb", t).unwrap();
        let Dropped::Away { until, .. } = r.disconnect("k", 1, t) else {
            panic!("not away")
        };
        assert_eq!(r.sweep(until - Duration::from_millis(1), WAIT), vec![], "not yet");
        assert_eq!(r.sweep(until, WAIT), vec![(End::Expired, "b")], "the waiting joiner is told");
        assert_eq!(r.stats().rooms, 0);
        assert_eq!(
            r.rejoin("k", Role::Creator, "ta", 3, "a2", t),
            Err(RoomError::NotFound)
        );
    }

    #[test]
    fn a_rejoin_displaces_a_socket_the_server_still_thinks_is_open() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        r.create("k", 1, HOME, "a", "ta", KEEP, now()).unwrap();
        r.join("k", 2, "b", "tb", t).unwrap();
        let (seated, displaced) = r.rejoin("k", Role::Creator, "ta", 3, "a2", t).unwrap();
        assert_eq!((seated.other, displaced), (Some("b"), Some("a")));
        assert_eq!(
            r.disconnect("k", 1, t),
            Dropped::Gone(None),
            "the displaced socket closing changes nothing"
        );
        assert_eq!(r.other("k", 2), Some(&"a2"));
        assert_eq!(r.stats().rooms, 1);
    }

    #[test]
    fn joining_while_the_creator_is_away_reports_how_long_it_waits() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        r.create("k", 1, HOME, "a", "ta", KEEP, now()).unwrap();
        assert!(matches!(
            r.disconnect("k", 1, t),
            Dropped::Away { other: None, .. }
        ));
        let s = r
            .join("k", 2, "b", "tb", t + Duration::from_secs(100))
            .unwrap();
        assert_eq!(
            (s.other, s.other_away),
            (None, Some(Duration::from_secs(200)))
        );
        let (back, _) = r.rejoin("k", Role::Creator, "ta", 3, "a2", t).unwrap();
        assert_eq!((back.pairing, back.other), (2, Some("b")));
    }

    #[test]
    fn creating_past_rooms_max_is_busy_until_a_room_ends() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        for i in 0..ROOMS_MAX {
            r.create(&format!("k{i}"), i as PeerId, client(i), (), "t", KEEP, t).unwrap();
        }
        assert_eq!(r.create("late", 0, HOME, (), "t", KEEP, t), Err(RoomError::Busy));
        r.leave("k0", 0);
        assert_eq!(r.create("late", 0, HOME, (), "t", KEEP, t), Ok(()));
    }

    #[test]
    fn a_room_nobody_joined_ends_when_its_wait_runs_out() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        r.create("k", 1, HOME, "a", "ta", KEEP, t).unwrap();
        assert_eq!(r.sweep(t + WAIT - Duration::from_millis(1), WAIT), vec![], "not yet");
        assert_eq!(r.sweep(t + WAIT, WAIT), vec![(End::Unjoined, "a")]);
        assert_eq!(r.stats().rooms, 0);
        assert_eq!(r.stats().ended[End::Unjoined as usize], 1);
        assert_eq!(r.join("k", 2, "b", "tb", t), Err(RoomError::NotFound));
    }

    #[test]
    fn the_wait_spares_a_joined_room_and_a_room_created_later() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        r.create("joined", 1, HOME, "a", "ta", KEEP, t).unwrap();
        r.join("joined", 2, "b", "tb", t).unwrap();
        r.leave("joined", 2);
        r.create("joined", 3, HOME, "c", "tc", KEEP, t).unwrap();
        r.join("joined", 4, "d", "td", t).unwrap();
        r.create("later", 5, HOME, "e", "te", KEEP, t + Duration::from_secs(1)).unwrap();
        assert_eq!(r.sweep(t + WAIT, WAIT), vec![], "a taken joiner seat, and a room still in its wait");
        assert_eq!(r.stats().rooms, 2);
        assert_eq!(r.sweep(t + WAIT + Duration::from_secs(1), WAIT), vec![(End::Unjoined, "e")]);
    }

    #[test]
    fn a_joiner_that_left_and_came_back_is_not_swept_as_unjoined() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        r.create("k", 1, HOME, "a", "ta", KEEP, t).unwrap();
        r.join("k", 2, "b", "tb", t).unwrap();
        let Dropped::Away { until, .. } = r.disconnect("k", 2, t + WAIT) else {
            panic!("not away")
        };
        assert_eq!(r.sweep(t + WAIT, WAIT), vec![], "an away joiner still holds its seat");
        r.rejoin("k", Role::Joiner, "tb", 3, "b2", t + WAIT).unwrap();
        assert_eq!(r.sweep(until, WAIT), vec![]);
        assert_eq!(r.stats().rooms, 1);
    }

    #[test]
    fn stats_count_seats_and_each_way_a_room_ends() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        r.create("a", 1, HOME, (), "t1", KEEP, now()).unwrap();
        r.join("a", 2, (), "t2", t).unwrap();
        r.create("b", 3, HOME, (), "t3", Duration::ZERO, now()).unwrap();
        let Dropped::Away { until, .. } = r.disconnect("a", 2, t) else {
            panic!("seat should be away")
        };
        assert_eq!(
            r.stats(),
            Stats {
                rooms: 2,
                here: 2,
                away: 1,
                ended: [0, 0, 0, 0]
            }
        );

        r.disconnect("b", 3, t);
        r.sweep(until, WAIT);
        r.create("c", 4, HOME, (), "t4", KEEP, now()).unwrap();
        r.leave("c", 4);
        assert_eq!(
            r.leave("c", 4),
            None,
            "a second leave of a gone room counts nothing"
        );
        assert_eq!(
            r.stats(),
            Stats {
                rooms: 0,
                here: 0,
                away: 0,
                ended: [1, 1, 1, 0]
            }
        );
    }

    #[test]
    fn a_client_creates_rooms_per_client_and_another_client_still_can() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        for i in 0..ROOMS_PER_CLIENT {
            r.create(&format!("k{i}"), 1, HOME, (), "t", KEEP, t).unwrap();
        }
        assert_eq!(r.create("late", 1, HOME, (), "t", KEEP, t), Err(RoomError::TooMany));
        assert_eq!(r.create("other", 2, ip("203.0.113.8"), (), "t", KEEP, t), Ok(()));
        assert_eq!(
            r.join("k0", 3, (), "tj", t).map(|s| s.pairing),
            Ok(1),
            "joining someone's room is not capped"
        );
    }

    #[test]
    fn ipv6_counts_by_the_64_and_the_48() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        for i in 0..ROOMS_PER_CLIENT {
            r.create(&format!("a{i}"), 1, ip(&format!("2001:db8:1:1::{i:x}")), (), "t", KEEP, t).unwrap();
        }
        assert_eq!(r.create("a", 1, ip("2001:db8:1:1:ffff::1"), (), "t", KEEP, t), Err(RoomError::TooMany), "same /64");

        let per_network = ROOMS_PER_NETWORK / ROOMS_PER_CLIENT;
        for subnet in 2..=per_network {
            for i in 0..ROOMS_PER_CLIENT {
                let address = ip(&format!("2001:db8:1:{subnet:x}::{i:x}"));
                r.create(&format!("b{subnet}-{i}"), 1, address, (), "t", KEEP, t).unwrap();
            }
        }
        assert_eq!(r.create("b", 1, ip("2001:db8:1:ffff::1"), (), "t", KEEP, t), Err(RoomError::TooMany), "same /48");
        assert_eq!(r.create("c", 1, ip("2001:db8:2::1"), (), "t", KEEP, t), Ok(()), "next /48");

        r.leave("a0", 1);
        assert_eq!(r.create("b", 1, ip("2001:db8:1:ffff::1"), (), "t", KEEP, t), Ok(()), "a room ended frees the /48");
    }

    #[test]
    fn every_way_a_room_ends_frees_its_count() {
        let mut r = Rooms::new(ROOMS_PER_CLIENT);
        let t = now();
        let fill = |r: &mut Rooms<&str>| {
            for i in 1..ROOMS_PER_CLIENT {
                // Created a second after `k`, so sweeping `k`'s wait spares them.
                r.create(&format!("fill{i}"), 9, HOME, "f", "t", KEEP, t + Duration::from_secs(1)).unwrap();
            }
        };
        fill(&mut r);
        let cycle = |r: &mut Rooms<&str>, end: &dyn Fn(&mut Rooms<&str>)| {
            r.create("k", 1, HOME, "a", "ta", KEEP, t).unwrap();
            assert_eq!(r.create("x", 1, HOME, "a", "tx", KEEP, t), Err(RoomError::TooMany));
            end(r);
            assert_eq!(r.stats().rooms as u32, ROOMS_PER_CLIENT - 1);
        };

        cycle(&mut r, &|r| {
            r.leave("k", 1);
        });
        cycle(&mut r, &|r| {
            r.sweep(t + WAIT, WAIT);
        });
        cycle(&mut r, &|r| {
            r.join("k", 2, "b", "tb", t).unwrap();
            let Dropped::Away { until, .. } = r.disconnect("k", 2, t) else {
                panic!("not away")
            };
            r.sweep(until, WAIT);
        });
        cycle(&mut r, &|r| {
            r.join("k", 2, "b", "tb", t).unwrap();
            r.leave("k", 2);
        });
        r.create("off", 1, HOME, "a", "ta", Duration::ZERO, t).unwrap();
        r.disconnect("off", 1, t);
        assert_eq!(r.stats().ended, [2, 1, 1, 1]);
        assert_eq!(r.create("k", 1, HOME, "a", "ta", KEEP, t), Ok(()), "a closed room freed its count");
        assert_eq!(r.held.len(), 1);
    }
}
