//! `e2ft --health`: checks a running server for a container health check, since the image has no shell or curl.
//! One `GET /` to `ADDR`, then for each TURN server in `TURN_URLS` a Binding, an Allocate with a credential signed
//! from `TURN_SECRET` the way the server signs them, and a zero-lifetime Refresh that frees the relay port at once.
//! Exit 0 when everything passes; otherwise one line on stderr naming the failed step, exit 1. The secret and the
//! credential are never printed.

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::stun::{self, Reply};

const HTTP_BUDGET: Duration = Duration::from_secs(2);
/// The whole check; the image's HEALTHCHECK timeout must stay above it.
const BUDGET: Duration = Duration::from_secs(4);
/// REQUESTED-TRANSPORT: UDP, the only relay coturn allows here.
const UDP_RELAY: [u8; 4] = [17, 0, 0, 0];

pub fn run() -> i32 {
    match check() {
        Ok(()) => 0,
        Err(message) => {
            eprintln!("health: {message}");
            1
        }
    }
}

fn check() -> Result<(), String> {
    let start = Instant::now();
    http(local(crate::config::address("ADDR", crate::config::ADDR)), start + HTTP_BUDGET)?;

    let urls = crate::ice::list("TURN_URLS", "");
    if urls.is_empty() {
        return Ok(());
    }
    let secret = std::env::var("TURN_SECRET").map_err(|_| "TURN_URLS is set but TURN_SECRET is not".to_string())?;
    let mut servers: Vec<Turn> = vec![];
    for url in &urls {
        if url.starts_with("turns:") {
            eprintln!("health: {url}: TLS is not checked");
            continue;
        }
        let server = Turn::parse(url).ok_or_else(|| format!("{url}: not a turn: URL"))?;
        if !servers.iter().any(|seen| (&seen.host, seen.port, seen.tcp) == (&server.host, server.port, server.tcp)) {
            servers.push(server);
        }
    }
    for server in &servers {
        turn(server, secret.as_bytes(), start + BUDGET).map_err(|message| format!("{}: {message}", server.url))?;
    }

    Ok(())
}

/// The server listens on every address when `ADDR` is unspecified; the check reaches it on loopback.
fn local(mut addr: SocketAddr) -> SocketAddr {
    if addr.ip().is_unspecified() {
        addr.set_ip(if addr.is_ipv4() { Ipv4Addr::LOCALHOST.into() } else { Ipv6Addr::LOCALHOST.into() });
    }

    addr
}

fn left(deadline: Instant) -> Result<Duration, String> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err("timed out".into());
    }

    Ok(left)
}

/// A read timeout shows as WouldBlock on Unix.
fn io(err: std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => "no response".into(),
        _ => err.to_string(),
    }
}

fn http(addr: SocketAddr, deadline: Instant) -> Result<(), String> {
    let fail = |err| format!("server on {addr}: {}", io(err));
    let mut stream = TcpStream::connect_timeout(&addr, left(deadline)?).map_err(fail)?;
    stream.set_read_timeout(Some(left(deadline)?)).map_err(fail)?;
    write!(stream, "GET / HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").map_err(fail)?;
    let mut status = String::new();
    BufReader::new(stream).read_line(&mut status).map_err(fail)?;
    if !is_ok(&status) {
        return Err(format!("server on {addr} answered {:?}", status.trim_end()));
    }

    Ok(())
}

fn is_ok(status: &str) -> bool {
    let mut parts = status.split(' ');

    parts.next().is_some_and(|version| version.starts_with("HTTP/1.")) && parts.next() == Some("200")
}

struct Turn {
    url: String,
    host: String,
    port: u16,
    tcp: bool,
}

impl Turn {
    /// `turn:host[:port][?transport=udp|tcp]`, an IPv6 host in brackets; UDP and port 3478 by default.
    fn parse(url: &str) -> Option<Turn> {
        let (address, query) = url.strip_prefix("turn:")?.split_once('?').unwrap_or((url.strip_prefix("turn:")?, ""));
        let tcp = match query {
            "" | "transport=udp" => false,
            "transport=tcp" => true,
            _ => return None,
        };
        let (host, port) = match address.strip_prefix('[') {
            Some(bracketed) => {
                let (host, rest) = bracketed.split_once(']')?;
                (host, rest.strip_prefix(':'))
            }
            None => match address.split_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (address, None),
            },
        };
        let port = port.map_or(Some(3478), |port| port.parse().ok())?;
        if host.is_empty() {
            return None;
        }

        Some(Turn { url: url.into(), host: host.into(), port, tcp })
    }
}

/// One TURN server's control connection; on TCP the messages follow each other on the stream.
enum Link {
    Udp(UdpSocket),
    Tcp(TcpStream),
}

impl Link {
    fn open(server: &Turn, deadline: Instant) -> Result<Link, String> {
        let addr = (server.host.as_str(), server.port)
            .to_socket_addrs()
            .map_err(|err| format!("cannot resolve: {err}"))?
            .next()
            .ok_or("cannot resolve: no address")?;
        let fail = |err: std::io::Error| format!("unreachable: {err}");
        if server.tcp {
            return Ok(Link::Tcp(TcpStream::connect_timeout(&addr, left(deadline)?).map_err(fail)?));
        }
        let any: SocketAddr =
            if addr.is_ipv4() { (Ipv4Addr::UNSPECIFIED, 0).into() } else { (Ipv6Addr::UNSPECIFIED, 0).into() };
        let socket = UdpSocket::bind(any).map_err(fail)?;
        socket.connect(addr).map_err(fail)?;

        Ok(Link::Udp(socket))
    }

    /// Sends a request and waits for its response; other datagrams are dropped.
    fn ask(
        &mut self,
        method: u16,
        attributes: &[(u16, &[u8])],
        key: Option<&[u8]>,
        deadline: Instant,
    ) -> Result<Reply, String> {
        let id = crate::discover::random();
        let message = stun::request(method, id, attributes, key);
        match self {
            Link::Udp(socket) => {
                socket.send(&message).map_err(io)?;
                let mut buffer = [0; 1500];
                loop {
                    socket.set_read_timeout(Some(left(deadline)?)).map_err(io)?;
                    let size = socket.recv(&mut buffer).map_err(io)?;
                    if let Some(reply) = Reply::parse(&buffer[..size], method, id) {
                        return Ok(reply);
                    }
                }
            }
            Link::Tcp(stream) => {
                stream.write_all(&message).map_err(io)?;
                loop {
                    stream.set_read_timeout(Some(left(deadline)?)).map_err(io)?;
                    let mut header = [0; stun::HEADER];
                    stream.read_exact(&mut header).map_err(io)?;
                    let mut bytes = header.to_vec();
                    bytes.resize(stun::length(&header), 0);
                    stream.read_exact(&mut bytes[stun::HEADER..]).map_err(io)?;
                    if let Some(reply) = Reply::parse(&bytes, method, id) {
                        return Ok(reply);
                    }
                }
            }
        }
    }
}

fn turn(server: &Turn, secret: &[u8], deadline: Instant) -> Result<(), String> {
    let mut link = Link::open(server, deadline)?;

    let binding = link.ask(stun::BINDING, &[], None, deadline).map_err(|err| format!("binding: {err}"))?;
    if let Some(code) = binding.error {
        return Err(format!("binding: error {code}"));
    }

    let challenge = link
        .ask(stun::ALLOCATE, &[(stun::REQUESTED_TRANSPORT, &UDP_RELAY)], None, deadline)
        .map_err(|err| format!("allocate: {err}"))?;
    let (Some(401), Some(realm), Some(nonce)) =
        (challenge.error, challenge.attribute(stun::REALM), challenge.attribute(stun::NONCE))
    else {
        return Err("allocate: expected a 401 challenge with a realm and a nonce".into());
    };

    let now = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock after 1970").as_secs();
    let username = (now + crate::ice::TURN_TTL_SECS).to_string();
    let key = stun::long_term_key(&username, realm, &crate::ice::credential(secret, &username));
    let login: [(u16, &[u8]); 3] =
        [(stun::USERNAME, username.as_bytes()), (stun::REALM, realm), (stun::NONCE, nonce)];

    let allocate = [&[(stun::REQUESTED_TRANSPORT, &UDP_RELAY[..])], &login[..]].concat();
    let allocation =
        link.ask(stun::ALLOCATE, &allocate, Some(&key), deadline).map_err(|err| format!("allocate: {err}"))?;
    match allocation.error {
        None => {}
        Some(401) => return Err("credential rejected: TURN_SECRET differs from coturn's".into()),
        Some(code) => return Err(format!("allocate: error {code}")),
    }

    let free = [&[(stun::LIFETIME, &[0u8; 4][..])], &login[..]].concat();
    let refresh = link
        .ask(stun::REFRESH, &free, Some(&key), deadline)
        .map_err(|err| format!("free the allocation: {err}"))?;
    if let Some(code) = refresh.error {
        return Err(format!("free the allocation: error {code}"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unspecified_addresses_map_to_loopback() {
        let addr = |text: &str| text.parse::<SocketAddr>().unwrap();
        assert_eq!(local(addr("0.0.0.0:8080")), addr("127.0.0.1:8080"));
        assert_eq!(local(addr("[::]:8080")), addr("[::1]:8080"));
        assert_eq!(local(addr("10.0.0.5:80")), addr("10.0.0.5:80"));
    }

    #[test]
    fn only_a_200_status_line_passes() {
        assert!(is_ok("HTTP/1.1 200 OK\r\n"));
        assert!(is_ok("HTTP/1.0 200 OK\r\n"));
        assert!(!is_ok("HTTP/1.1 503 Service Unavailable\r\n"));
        assert!(!is_ok("HTTP/1.1 2000\r\n"));
        assert!(!is_ok("SSH-2.0-OpenSSH 200\r\n"));
        assert!(!is_ok(""));
    }

    fn turn_url(url: &str) -> Option<(String, u16, bool)> {
        Turn::parse(url).map(|turn| (turn.host, turn.port, turn.tcp))
    }

    #[test]
    fn parses_turn_urls() {
        assert_eq!(turn_url("turn:relay.example:3478?transport=udp"), Some(("relay.example".into(), 3478, false)));
        assert_eq!(turn_url("turn:relay.example?transport=tcp"), Some(("relay.example".into(), 3478, true)));
        assert_eq!(turn_url("turn:203.0.113.7:5349"), Some(("203.0.113.7".into(), 5349, false)));
        assert_eq!(turn_url("turn:[2001:db8::1]:3479?transport=tcp"), Some(("2001:db8::1".into(), 3479, true)));
        assert_eq!(turn_url("turn:[2001:db8::1]"), Some(("2001:db8::1".into(), 3478, false)));
        assert_eq!(turn_url("turns:relay.example"), None);
        assert_eq!(turn_url("turn:relay.example:http"), None);
        assert_eq!(turn_url("turn:relay.example?transport=sctp"), None);
        assert_eq!(turn_url("turn::3478"), None);
    }

    fn soon() -> Instant {
        Instant::now() + BUDGET
    }

    #[test]
    fn nothing_listening_fails_fast() {
        let closed = TcpStream::connect("127.0.0.1:1").map(|_| ()).err();
        assert!(closed.is_some(), "port 1 is closed on this machine");
        let start = Instant::now();
        assert!(http("127.0.0.1:1".parse().unwrap(), start + HTTP_BUDGET).is_err());
        assert!(start.elapsed() < HTTP_BUDGET);

        let server = Turn::parse("turn:127.0.0.1:1").unwrap();
        let err = turn(&server, b"secret", soon()).unwrap_err();
        assert!(err.starts_with("binding:"), "{err}");
    }

    // The loopback coturn of web/scripts/coturn.sh on 3481, which takes the shared secret E2E_TURN_SECRET: start
    // it, then `cargo test -- --ignored`.
    const LOOPBACK: &str = "turn:127.0.0.1:3481";
    const RELAY_PORTS: usize = 40;

    fn loopback_secret() -> String {
        std::env::var("E2E_TURN_SECRET").unwrap_or_else(|_| "e2e-loopback-turn-secret-0123456789".into())
    }

    #[test]
    #[ignore = "needs web/scripts/coturn.sh start"]
    fn allocates_and_frees_on_a_coturn_sharing_the_secret() {
        let secret = loopback_secret();
        for transport in ["udp", "tcp"] {
            let server = Turn::parse(&format!("{LOOPBACK}?transport={transport}")).unwrap();
            // Two rounds of as many checks as the coturn has relay ports. It frees a zero-lifetime allocation on its
            // next timer tick, within a second; one left to expire would hold its port for ten minutes.
            for round in 0..2 {
                for check in 0..RELAY_PORTS {
                    turn(&server, secret.as_bytes(), soon())
                        .unwrap_or_else(|err| panic!("{transport} round {round} check {check}: {err}"));
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    }

    #[test]
    #[ignore = "needs web/scripts/coturn.sh start"]
    fn another_secret_is_rejected() {
        let server = Turn::parse(LOOPBACK).unwrap();
        let err = turn(&server, b"not-the-secret-coturn-was-given-0123", soon()).unwrap_err();
        assert_eq!(err, "credential rejected: TURN_SECRET differs from coturn's");
    }
}
