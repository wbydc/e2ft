//! The /ws relay: a peer's text hello (create, join, rejoin) takes a seat in a room, then its binary frames go
//! verbatim to the other seat. The frames are sealed end to end, so the server reads none of them.

use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ConnectInfo, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::Response,
};
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use serde::Deserialize;
use tokio::{sync::mpsc, task::JoinHandle};

use crate::App;
use crate::bucket::Bucket;
use crate::discover::client;
use crate::signal::ice::Ice;
use crate::metrics::Metrics;
use crate::signal::rooms::{Dropped, End, PeerId, Role, Seated};

/// Sealed SDP/ICE frames are a few KB; anything bigger is not ours.
const MAX_FRAME: usize = 64 * 1024;
/// Per-peer outbound queue. A full queue means the peer is not reading, so frames are dropped,
/// which breaks the sealed stream's sequence and fails that connection (by design).
pub(crate) const QUEUE: usize = 256;
const PING_EVERY: Duration = Duration::from_secs(15);
/// Bytes a socket may relay at once, then per second. A pairing with 8 lanes each way is well under 100 KB, and the
/// busiest minute the deployed server saw relayed 13.5 KB for every room together; a socket past this is moving
/// data, not signalling.
const RELAY_BURST: f64 = 256.0 * 1024.0;
const RELAY_PER_SECOND: f64 = 16.0 * 1024.0;
/// How often `sweep` looks for rooms whose wait or keep-alive ran out; a room ends at most this late.
const SWEEP_EVERY: Duration = Duration::from_secs(1);
/// No frame (pongs included) for this long: the socket is dead, so its seat goes away.
const IDLE: Duration = Duration::from_secs(40);

pub(crate) type Tx = mpsc::Sender<Message>;

pub(crate) async fn ws(
    ws: WebSocketUpgrade,
    ConnectInfo(peer_address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    State(app): State<Arc<App>>,
) -> Response {
    // No usable X-Forwarded-For behind a trusted proxy: count it under the proxy rather than not at all.
    let address = client(peer_address, &headers, &app.trusted_proxies)
        .map_or(peer_address.ip(), |(address, _)| address);

    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| peer(socket, app, address))
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Hello {
    Create {
        room: String,
        token: String,
        /// The creator's choice, or KEEP_ALIVE when its hello has none.
        #[serde(rename = "keepAlive")]
        keep_alive: Option<u64>,
    },
    Join {
        room: String,
        token: String,
    },
    Rejoin {
        room: String,
        token: String,
        role: HelloRole,
    },
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum HelloRole {
    Creator,
    Joiner,
}

/// The room id (accessKey) is ACCESS_LEN (8 by default) base64url chars.
pub(crate) fn valid_room(k: &str, access_len: usize) -> bool {
    b64url_of_len(k, access_len)
}

/// The seat token stays 22 base64url chars.
fn valid_token(k: &str) -> bool {
    b64url_of_len(k, 22)
}

fn b64url_of_len(k: &str, len: usize) -> bool {
    k.len() == len
        && k.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn ctl(t: &str) -> Message {
    Message::Text(serde_json::json!({ "t": t }).to_string().into())
}

/// A (re)pairing: this peer gets ICE servers, with TURN credentials when `turn`, the pairing number and the room's
/// keep-alive.
fn paired<T>(t: &str, ice: &Ice, turn: bool, s: &Seated<T>) -> Message {
    let keep_alive = s.keep_alive.as_secs();
    Message::Text(serde_json::json!({ "t": t, "iceServers": ice.servers(turn), "gen": s.pairing, "keepAlive": keep_alive }).to_string().into())
}

/// Charges `count` TURN credentials to `address`, counting a refusal.
fn turn_for(app: &App, address: IpAddr, count: u32) -> bool {
    let turn = app.ice.charge(address, count, Instant::now());
    if !turn {
        Metrics::bump(&app.metrics.turn_withheld, count.into());
    }

    turn
}

fn away(left: Duration) -> Message {
    Message::Text(
        serde_json::json!({ "t": "peer-away", "wait": left.as_secs() })
            .to_string()
            .into(),
    )
}

fn ctl_err(code: &str) -> Message {
    Message::Text(
        serde_json::json!({ "t": "error", "e": code })
            .to_string()
            .into(),
    )
}

fn bye(other: &Tx) {
    let _ = other.try_send(ctl("peer-left"));
    let _ = other.try_send(Message::Close(None));
}

/// Ends the rooms whose wait or keep-alive ran out and tells the peer still in each, and forgets refilled TURN
/// budgets. One task for every room, so a room that ends early leaves no timer behind.
pub(crate) async fn sweep(app: Arc<App>) {
    let mut tick = tokio::time::interval(SWEEP_EVERY);
    loop {
        tick.tick().await;
        let now = Instant::now();
        app.ice.prune(now);
        let ended = app.rooms.lock().unwrap().sweep(now, app.room_wait);
        for (cause, peer) in ended {
            match cause {
                End::Unjoined => {
                    let _ = peer.try_send(ctl_err("unjoined"));
                    let _ = peer.try_send(Message::Close(None));
                }
                _ => bye(&peer),
            }
        }
    }
}

/// Tells a peer that just took a seat about the other seat, and the other peer that it is (back) there. The seated
/// peer's client (`address`) pays for both peers' TURN credentials, since its hello caused the pairing.
fn seated(app: &App, address: IpAddr, tx: &Tx, me: &str, other_event: &str, s: Seated<Tx>) {
    match (&s.other, s.other_away) {
        (Some(other), _) => {
            let turn = turn_for(app, address, 2);
            let _ = tx.try_send(paired(me, &app.ice, turn, &s));
            let _ = other.try_send(paired(other_event, &app.ice, turn, &s));
        }
        (None, away_for) => {
            let _ = tx.try_send(if me == "joined" {
                paired(me, &app.ice, turn_for(app, address, 1), &s)
            } else {
                ctl(me)
            });
            if let Some(left) = away_for {
                let _ = tx.try_send(away(left));
            }
        }
    }
}

/// Sends a socket's queued frames and a ping every `ping_every`; ends once it sent a Close or the socket failed.
pub(crate) fn spawn_writer(
    mut sink: SplitSink<WebSocket, Message>,
    mut rx: mpsc::Receiver<Message>,
    ping_every: Duration,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ping = tokio::time::interval(ping_every);
        ping.tick().await;
        loop {
            let msg = tokio::select! {
                m = rx.recv() => match m { Some(m) => m, None => break },
                _ = ping.tick() => Message::Ping(Default::default()),
            };
            let close = matches!(msg, Message::Close(_));
            if sink.send(msg).await.is_err() || close {
                break;
            }
        }
    })
}

/// One WebSocket peer, counted against its client's socket limit: first a text hello (create/join/rejoin), then
/// binary frames relayed verbatim to the other peer, until the socket closes (seat away) or the peer sends
/// {"t":"leave"} (room deleted).
async fn peer(socket: WebSocket, app: Arc<App>, address: IpAddr) {
    let (sink, mut stream) = socket.split();
    let (tx, rx) = mpsc::channel::<Message>(QUEUE);
    let mut writer = spawn_writer(sink, rx, PING_EVERY);

    if !app.sockets.lock().unwrap().open(address) {
        app.metrics.error("too-many");
        let _ = tx.try_send(ctl_err("too-many"));
        let _ = tx.try_send(Message::Close(None));
        drop(tx);
        let _ = writer.await;
        return;
    }

    let id: PeerId = app.next_peer.fetch_add(1, Ordering::Relaxed);
    let mut relay_budget = Bucket::new(RELAY_BURST, RELAY_PER_SECOND, Instant::now());
    let mut room: Option<String> = None;
    let mut left = false;

    let read = async {
        // A suspended phone's socket can stay open for minutes without a word; pongs count as words.
        while let Ok(Some(Ok(msg))) = tokio::time::timeout(IDLE, stream.next()).await {
            match (msg, &room) {
                (Message::Text(t), None) => {
                    let Ok(hello) = serde_json::from_str::<Hello>(&t) else {
                        break;
                    };
                    let now = Instant::now();
                    let key = match hello {
                        Hello::Create {
                            room,
                            token,
                            keep_alive,
                        } if valid_room(&room, app.settings.access_len) && valid_token(&token) => {
                            // KEEP_ALIVES caps how long a room can sit in memory.
                            let keep_alive = keep_alive.unwrap_or(app.settings.keep_alive);
                            if !app.settings.keep_alives.contains(&keep_alive) {
                                app.metrics.error("keep-alive");
                                let _ = tx.try_send(ctl_err("keep-alive"));
                                break;
                            }
                            let r = app.rooms.lock().unwrap().create(
                                &room,
                                id,
                                address,
                                tx.clone(),
                                &token,
                                Duration::from_secs(keep_alive),
                                now,
                            );
                            if let Err(e) = r {
                                app.metrics.error(e.code());
                                let _ = tx.try_send(ctl_err(e.code()));
                                break;
                            }
                            Metrics::bump(&app.metrics.created, 1);
                            let _ = tx.try_send(ctl("created"));
                            room
                        }
                        Hello::Join { room, token }
                            if valid_room(&room, app.settings.access_len) && valid_token(&token) =>
                        {
                            let r =
                                app.rooms
                                    .lock()
                                    .unwrap()
                                    .join(&room, id, tx.clone(), &token, now);
                            match r {
                                Ok(s) => {
                                    Metrics::bump(&app.metrics.joined, 1);
                                    seated(&app, address, &tx, "joined", "peer-joined", s);
                                }
                                Err(e) => {
                                    app.metrics.error(e.code());
                                    let _ = tx.try_send(ctl_err(e.code()));
                                    break;
                                }
                            }
                            room
                        }
                        Hello::Rejoin { room, token, role }
                            if valid_room(&room, app.settings.access_len) && valid_token(&token) =>
                        {
                            let role = match role {
                                HelloRole::Creator => Role::Creator,
                                HelloRole::Joiner => Role::Joiner,
                            };
                            let r = app.rooms.lock().unwrap().rejoin(
                                &room,
                                role,
                                &token,
                                id,
                                tx.clone(),
                                now,
                            );
                            match r {
                                Ok((s, displaced)) => {
                                    Metrics::bump(&app.metrics.rejoined, 1);
                                    if let Some(old) = displaced {
                                        let _ = old.try_send(Message::Close(None));
                                    }
                                    seated(&app, address, &tx, "rejoined", "peer-back", s);
                                }
                                Err(e) => {
                                    app.metrics.error(e.code());
                                    let _ = tx.try_send(ctl_err(e.code()));
                                    break;
                                }
                            }
                            room
                        }
                        _ => break,
                    };
                    room = Some(key);
                }
                (Message::Text(t), Some(key)) if t.as_str() == r#"{"t":"ice"}"# => {
                    if !relay_budget.take(t.len() as f64, Instant::now()) {
                        app.metrics.error("rate");
                        let _ = tx.try_send(ctl_err("rate"));
                        break;
                    }
                    // Fresh TURN credentials for a new connection inside a paired room; unpaired, no answer.
                    let paired = app.rooms.lock().unwrap().other(key, id).is_some();
                    if paired {
                        let turn = turn_for(&app, address, 1);
                        let _ = tx.try_send(Message::Text(
                            serde_json::json!({ "t": "ice", "iceServers": app.ice.servers(turn) }).to_string().into(),
                        ));
                    }
                }
                (Message::Text(t), Some(_)) => {
                    left = t.as_str() == r#"{"t":"leave"}"#;
                    break;
                }
                (Message::Binary(b), Some(key)) => {
                    if !relay_budget.take(b.len() as f64, Instant::now()) {
                        app.metrics.error("rate");
                        let _ = tx.try_send(ctl_err("rate"));
                        break;
                    }
                    // No other peer now, or the room is gone (we are being closed): drop the frame.
                    let other = app.rooms.lock().unwrap().other(key, id).cloned();
                    if let Some(other) = other {
                        let len = b.len() as u64;
                        if other.try_send(Message::Binary(b)).is_ok() {
                            Metrics::bump(&app.metrics.relayed_frames, 1);
                            Metrics::bump(&app.metrics.relayed_bytes, len);
                        } else {
                            Metrics::bump(&app.metrics.dropped_frames, 1);
                        }
                    }
                }
                (Message::Ping(_) | Message::Pong(_), _) => {}
                _ => break,
            }
        }
    };
    // The writer ends when it sent a Close: a rejoin displaced this socket, or the room ended.
    let writer_done = tokio::select! {
        _ = read => false,
        _ = &mut writer => true,
    };

    if let Some(key) = room {
        if left {
            if let Some(other) = app.rooms.lock().unwrap().leave(&key, id) {
                bye(&other);
            }
        } else {
            let dropped = app
                .rooms
                .lock()
                .unwrap()
                .disconnect(&key, id, Instant::now());
            match dropped {
                Dropped::Gone(other) => other.iter().for_each(bye),
                Dropped::Away { until, other } => {
                    if let Some(other) = other {
                        let _ =
                            other.try_send(away(until.saturating_duration_since(Instant::now())));
                    }
                }
            }
        }
    }
    app.sockets.lock().unwrap().close(address);
    let _ = tx.try_send(Message::Close(None));
    drop(tx);
    if !writer_done {
        let _ = writer.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_keys_have_fixed_lengths() {
        let access_len = crate::settings::Settings::default().access_len;
        let room = "Vq3k_9Za".repeat(2)[..access_len].to_owned();
        assert!(valid_room(&room, access_len));
        assert!(!valid_room(&format!("{room}V"), access_len));
        assert!(!valid_room(&format!("{}*", &room[1..]), access_len));
        assert!(valid_token("Vq3k_9ZaVq3k_9ZaVq3k-9"));
        assert!(!valid_token("Vq3k_9Za"));
        assert!(!valid_token("Vq3k_9ZaVq3k_9ZaVq3k/9"));
    }
}
