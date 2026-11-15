//! The /discover socket: a home page that chose to be visible says hello with its name, is told which other
//! visible pages share its network, and can ask one of them to start a room. The client address is used once, here,
//! to pick the group; only its keyed hash is kept, and nothing of it is logged or counted.

use std::{
    io::Read,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ConnectInfo, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, header::HeaderName},
    response::Response,
};
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::sync::mpsc;

use crate::App;
use crate::bucket::Bucket;
use crate::lobby::{BURST, Device, LobbyId, Network, PER_SECOND};
use crate::relay::{QUEUE, spawn_writer, valid_room};

/// A hello, an ask or an answer is a few hundred bytes.
const MAX_FRAME: usize = 4096;
/// Shorter than the room socket's: a page that lost its network should leave the others' lists within seconds,
/// while a room seat must survive a suspended phone.
const PING_EVERY: Duration = Duration::from_secs(5);
/// No frame (pongs included) for this long: the page is gone, so it leaves its group.
const IDLE: Duration = Duration::from_secs(15);
const FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");

/// Random bytes from the kernel, for the lobby key and the per-socket ids.
pub(crate) fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .expect("read /dev/urandom");
    bytes
}

/// An address block, as written in `TRUSTED_PROXIES`: `10.244.0.0/16`, `2400:cb00::/32`, or one address.
pub(crate) struct Cidr {
    address: IpAddr,
    bits: u32,
}

/// An address as a number and its width in bits, an IPv4-mapped IPv6 address as its IPv4 form.
fn numeric(address: IpAddr) -> (u128, u32) {
    match address {
        IpAddr::V4(address) => (u32::from(address).into(), 32),
        IpAddr::V6(address) => match address.to_ipv4_mapped() {
            Some(address) => (u32::from(address).into(), 32),
            None => (address.into(), 128),
        },
    }
}

impl Cidr {
    pub(crate) fn parse(text: &str) -> Option<Cidr> {
        let (address, bits) = match text.split_once('/') {
            Some((address, bits)) => (address, Some(bits.parse::<u32>().ok()?)),
            None => (text, None),
        };
        let address: IpAddr = address.parse().ok()?;
        let width = numeric(address).1;
        let bits = bits.unwrap_or(width);

        (bits <= width).then_some(Cidr { address, bits })
    }

    fn contains(&self, address: IpAddr) -> bool {
        let (block, width) = numeric(self.address);
        let (address, address_width) = numeric(address);

        width == address_width && (self.bits == 0 || (block ^ address) >> (width - self.bits) == 0)
    }
}

/// The client's address and whether it is the socket's own. Behind a trusted proxy it is the rightmost
/// `X-Forwarded-For` entry that is not itself a trusted proxy: every entry to its right was written by a proxy we
/// trust, so a client cannot forge it. None when the header has no such entry or one that is not an address.
fn client_address(peer: IpAddr, forwarded: &str, trusted: &[Cidr]) -> Option<(IpAddr, bool)> {
    let is_trusted = |address: IpAddr| trusted.iter().any(|block| block.contains(address));
    if !is_trusted(peer) {
        return Some((peer, true));
    }

    for entry in forwarded.rsplit(',') {
        let address: IpAddr = entry.trim().parse().ok()?;
        if !is_trusted(address) {
            return Some((address, false));
        }
    }

    None
}

/// `client_address` for a request: its socket's peer and its `X-Forwarded-For` headers. A byte that is not text
/// spoils only the entry it is in, so a client can't make the whole header unreadable from the left of it.
pub(crate) fn client(peer: SocketAddr, headers: &HeaderMap, trusted: &[Cidr]) -> Option<(IpAddr, bool)> {
    let forwarded: Vec<_> = headers
        .get_all(FORWARDED_FOR)
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()))
        .collect();

    client_address(peer.ip(), &forwarded.join(","), trusted)
}

pub(crate) async fn ws(
    ws: WebSocketUpgrade,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    State(app): State<Arc<App>>,
) -> Response {
    let client = client(peer, &headers, &app.trusted_proxies);
    // Counted like /ws: no usable X-Forwarded-For behind a trusted proxy counts under the proxy.
    let address = client.map_or(peer.ip(), |(address, _)| address);
    // The address goes no further than this hash and the socket count; a page whose address forms no group is
    // listed to nobody.
    let network = client.and_then(|(address, direct)| Network::new(&app.lobby_key, address, direct));

    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| member(socket, app, address, network))
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Request {
    /// The first frame, and again after a rename.
    Hello { name: String, device: String },
    Ask { to: String },
    /// `room` is the access key of the room the asked page created; without it the ask is declined.
    Answer { to: String, room: Option<String> },
}

fn wire_id(id: LobbyId) -> String {
    format!("{id:016x}")
}

fn text(value: serde_json::Value) -> Message {
    Message::Text(value.to_string().into())
}

/// Tells every member of the group who else is in it.
fn announce(app: &App, network: &Network) {
    let lobby = app.lobby.lock().unwrap();
    let members = lobby.members(network);
    for (id, _, tx) in &members {
        let others: Vec<_> = members
            .iter()
            .filter(|(other, ..)| other != id)
            .map(|(other, device, _)| {
                serde_json::json!({ "id": wire_id(*other), "name": device.name, "device": device.device })
            })
            .collect();
        let _ = tx.try_send(text(serde_json::json!({ "t": "devices", "devices": others })));
    }
}

async fn member(socket: WebSocket, app: Arc<App>, address: IpAddr, network: Option<Network>) {
    let (sink, mut stream) = socket.split();
    let (tx, rx) = mpsc::channel::<Message>(QUEUE);
    let mut writer = spawn_writer(sink, rx, PING_EVERY);

    // The page retries after a close, so a refused socket needs no error frame.
    if !app.discover_sockets.lock().unwrap().open(address) {
        app.metrics.error("too-many");
        let _ = tx.try_send(Message::Close(None));
        drop(tx);
        let _ = writer.await;
        return;
    }

    let id = LobbyId::from_le_bytes(random());
    let mut entered = false;
    // Every hello can send the list to the whole group and every ask can open a dialog on another screen.
    let mut hellos = Bucket::new(BURST, PER_SECOND, Instant::now());
    let mut asks = Bucket::new(BURST, PER_SECOND, Instant::now());

    let read = async {
        while let Ok(Some(Ok(message))) = tokio::time::timeout(IDLE, stream.next()).await {
            let request = match message {
                Message::Text(frame) => match serde_json::from_str::<Request>(&frame) {
                    Ok(request) => request,
                    Err(_) => break,
                },
                Message::Ping(_) | Message::Pong(_) => continue,
                _ => break,
            };
            let allowed = match request {
                Request::Hello { .. } => hellos.take(1.0, Instant::now()),
                Request::Ask { .. } => asks.take(1.0, Instant::now()),
                Request::Answer { .. } => true,
            };
            if !allowed {
                break;
            }
            match (request, &network) {
                (Request::Hello { name, device }, network) => {
                    let Some(device) = Device::new(&name, &device) else {
                        break;
                    };
                    // No group for this address, or a full one: the page stays connected and sees nobody.
                    let changed = network.as_ref().and_then(|network| {
                        app.lobby.lock().unwrap().enter(network, id, device, tx.clone()).ok()
                    });
                    entered |= changed.is_some();
                    match (network, changed) {
                        (Some(network), Some(true)) => announce(&app, network),
                        // The same name again: nobody's list changes.
                        (_, Some(false)) => {}
                        _ => {
                            let _ = tx.try_send(text(serde_json::json!({ "t": "devices", "devices": [] })));
                        }
                    }
                }
                (Request::Ask { to }, Some(network)) if entered => {
                    let frame = serde_json::json!({ "t": "asked", "from": wire_id(id) });
                    if let Some(to) = parse_id(&to)
                        && let Some(asked) = app.lobby.lock().unwrap().ask(network, id, to)
                    {
                        let _ = asked.try_send(text(frame));
                    }
                }
                (Request::Answer { to, room }, Some(network)) if entered => {
                    if room.as_deref().is_some_and(|room| !valid_room(room, app.settings.access_len)) {
                        break;
                    }
                    let frame = serde_json::json!({ "t": "answered", "from": wire_id(id), "room": room });
                    // Only to a member whose ask is still open: answers have no bucket of their own (asks do).
                    if let Some(to) = parse_id(&to)
                        && let Some(asker) = app.lobby.lock().unwrap().answer(network, id, to)
                    {
                        let _ = asker.try_send(text(frame));
                    }
                }
                _ => {}
            }
        }
    };
    tokio::select! {
        _ = read => {}
        _ = &mut writer => {}
    }

    if let (true, Some(network)) = (entered, &network) {
        app.lobby.lock().unwrap().leave(network, id);
        announce(&app, network);
    }
    app.discover_sockets.lock().unwrap().close(address);
    let _ = tx.try_send(Message::Close(None));
    drop(tx);
    let _ = writer.await;
}

/// A member id as `wire_id` writes it. The lobby looks ids up in the sender's group only, so an id from any other
/// group reaches nobody.
fn parse_id(id: &str) -> Option<LobbyId> {
    LobbyId::from_str_radix(id, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn trusted() -> Vec<Cidr> {
        ["10.244.0.0/16", "173.245.48.0/20", "2400:cb00::/32", "127.0.0.1"]
            .iter()
            .map(|block| Cidr::parse(block).unwrap())
            .collect()
    }

    fn address(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn blocks_match_their_own_family_and_prefix() {
        let block = Cidr::parse("10.244.0.0/16").unwrap();
        assert!(block.contains(address("10.244.3.7")));
        assert!(block.contains(address("::ffff:10.244.3.7")), "a mapped address is its IPv4 form");
        assert!(!block.contains(address("10.245.0.1")));
        assert!(!block.contains(address("::1")));
        assert!(Cidr::parse("0.0.0.0/0").unwrap().contains(address("8.8.8.8")));
        assert!(Cidr::parse("2400:cb00::/32").unwrap().contains(address("2400:cb00:1::5")));
        assert!(!Cidr::parse("2400:cb00::/32").unwrap().contains(address("2400:cb01::5")));
        for bad in ["", "10.0.0.0/33", "::/129", "10.0.0.0/x", "proxy"] {
            assert!(Cidr::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn an_untrusted_peer_is_the_client_whatever_it_claims() {
        let client = client_address(address("203.0.113.9"), "8.8.8.8", &trusted());
        assert_eq!(client, Some((address("203.0.113.9"), true)));
        assert_eq!(client_address(address("8.8.4.4"), "", &[]), Some((address("8.8.4.4"), true)));
    }

    #[test]
    fn behind_trusted_proxies_the_client_is_the_rightmost_entry_they_did_not_write() {
        let peer = address("10.244.0.24");
        // The client sent a forged entry; the outer proxy appended the real one, the inner proxy appended the outer one.
        let chain = "8.8.8.8, 198.51.100.7, 173.245.48.9";
        assert_eq!(client_address(peer, chain, &trusted()), Some((address("198.51.100.7"), false)));
        assert_eq!(client_address(peer, "2001:db8::1", &trusted()), Some((address("2001:db8::1"), false)));
    }

    #[test]
    fn a_chain_with_no_client_or_with_junk_names_nobody() {
        let peer = address("10.244.0.24");
        // Traffic SNATed to a pod-network address: every entry is a trusted proxy, so there is no client.
        assert_eq!(client_address(peer, "10.244.2.0", &trusted()), None);
        assert_eq!(client_address(peer, "", &trusted()), None);
        assert_eq!(client_address(peer, "8.8.8.8, unknown", &trusted()), None);
    }

    #[test]
    fn a_non_ascii_byte_left_of_the_client_does_not_hide_it() {
        let peer: SocketAddr = "10.244.0.24:4000".parse().unwrap();
        let mut headers = HeaderMap::new();
        let forged = HeaderValue::from_bytes(b"8.8.8.8\xff\xfe, 198.51.100.7").unwrap();
        headers.append(FORWARDED_FOR, forged);
        headers.append(FORWARDED_FOR, HeaderValue::from_static("173.245.48.9"));
        assert_eq!(client(peer, &headers, &trusted()), Some((address("198.51.100.7"), false)));

        let mut headers = HeaderMap::new();
        headers.append(FORWARDED_FOR, HeaderValue::from_bytes(b"198.51.100.7\xff").unwrap());
        assert_eq!(client(peer, &headers, &trusted()), None, "the client's own entry spoiled");
    }

    #[test]
    fn a_pod_network_client_forms_no_group() {
        let key = [1; 32];
        let (client, direct) = client_address(address("10.244.0.24"), "", &[]).unwrap();
        assert!(Network::new(&key, client, direct).is_none(), "no TRUSTED_PROXIES: the peer is the proxy's pod");
        let pods = [Cidr::parse("10.244.0.0/16").unwrap()];
        let (client, direct) = client_address(address("10.244.0.24"), "127.0.0.1", &pods).unwrap();
        assert!(Network::new(&key, client, direct).is_none(), "loopback named by a header");
    }
}
