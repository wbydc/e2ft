//! `e2ft --health`: checks a running server for a container health check, since the image has no shell or curl.
//! One `GET /` to `ADDR`, then for each TURN server in `TURN_URLS` a Binding, an Allocate with a credential signed
//! from `TURN_SECRET` the way the server signs them, and a zero-lifetime Refresh that frees the relay port at once.
//! Exit 0 when everything passes; otherwise one line on stderr naming the failed step and the exit code of its
//! `Failure`. The secret and the credential are never printed.

mod stun;

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use stun::Reply;

const HTTP_BUDGET: Duration = Duration::from_secs(2);
/// The whole check; the image's HEALTHCHECK timeout must stay above it.
const BUDGET: Duration = Duration::from_secs(4);
/// REQUESTED-TRANSPORT: UDP, the only relay coturn allows here.
const UDP_RELAY: [u8; 4] = [17, 0, 0, 0];

/// Why the check failed. Docker and podman read any non-zero exit code as unhealthy; Docker reserves 2.
#[derive(Debug, PartialEq)]
enum Failure {
    /// Exit 1: the server does not answer on `ADDR`.
    Server(String),
    /// Exit 3: a TURN server is unreachable, silent or fails a step, or `TURN_URLS` is wrong.
    Turn(String),
    /// Exit 4: coturn rejected the signed credential, so `TURN_SECRET` differs from coturn's.
    Secret(String),
}

impl Failure {
    fn code(&self) -> i32 {
        match self {
            Failure::Server(_) => 1,
            Failure::Turn(_) => 3,
            Failure::Secret(_) => 4,
        }
    }
}

pub fn run() -> i32 {
    let Err(failure) = check() else {
        return 0;
    };
    let (Failure::Server(message) | Failure::Turn(message) | Failure::Secret(message)) = &failure;
    eprintln!("health: {message}");

    failure.code()
}

fn check() -> Result<(), Failure> {
    let start = Instant::now();
    http(local(crate::config::address("ADDR", crate::config::ADDR)), start + HTTP_BUDGET).map_err(Failure::Server)?;

    let urls = crate::signal::ice::list("TURN_URLS", "");
    if urls.is_empty() {
        return Ok(());
    }
    let secret =
        std::env::var("TURN_SECRET").map_err(|_| Failure::Turn("TURN_URLS is set but TURN_SECRET is not".into()))?;
    let mut servers: Vec<Turn> = vec![];
    for url in &urls {
        if url.starts_with("turns:") {
            eprintln!("health: {url}: TLS is not checked");
            continue;
        }
        let server = Turn::parse(url).ok_or_else(|| Failure::Turn(format!("{url}: not a turn: URL")))?;
        if !servers.iter().any(|seen| (&seen.host, seen.port, seen.tcp) == (&server.host, server.port, server.tcp)) {
            servers.push(server);
        }
    }
    for server in &servers {
        turn(server, secret.as_bytes(), start + BUDGET)?;
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

fn turn(server: &Turn, secret: &[u8], deadline: Instant) -> Result<(), Failure> {
    let fail = |step: String| Failure::Turn(format!("{}: {step}", server.url));
    let mut link = Link::open(server, deadline).map_err(fail)?;

    let binding = link.ask(stun::BINDING, &[], None, deadline).map_err(|err| fail(format!("binding: {err}")))?;
    if let Some(code) = binding.error {
        return Err(fail(format!("binding: error {code}")));
    }

    let challenge = link
        .ask(stun::ALLOCATE, &[(stun::REQUESTED_TRANSPORT, &UDP_RELAY)], None, deadline)
        .map_err(|err| fail(format!("allocate: {err}")))?;
    let (Some(401), Some(realm), Some(nonce)) =
        (challenge.error, challenge.attribute(stun::REALM), challenge.attribute(stun::NONCE))
    else {
        return Err(fail("allocate: expected a 401 challenge with a realm and a nonce".into()));
    };

    let now = SystemTime::now().duration_since(UNIX_EPOCH).expect("clock after 1970").as_secs();
    let username = (now + crate::signal::ice::TURN_TTL_SECS).to_string();
    let key = stun::long_term_key(&username, realm, &crate::signal::ice::credential(secret, &username));
    let login: [(u16, &[u8]); 3] =
        [(stun::USERNAME, username.as_bytes()), (stun::REALM, realm), (stun::NONCE, nonce)];

    let allocate = [&[(stun::REQUESTED_TRANSPORT, &UDP_RELAY[..])], &login[..]].concat();
    let allocation = link
        .ask(stun::ALLOCATE, &allocate, Some(&key), deadline)
        .map_err(|err| fail(format!("allocate: {err}")))?;
    match allocation.error {
        None => {}
        Some(401) => {
            let message = format!("{}: credential rejected: TURN_SECRET differs from coturn's", server.url);
            return Err(Failure::Secret(message));
        }
        Some(code) => return Err(fail(format!("allocate: error {code}"))),
    }

    let free = [&[(stun::LIFETIME, &[0u8; 4][..])], &login[..]].concat();
    let refresh = link
        .ask(stun::REFRESH, &free, Some(&key), deadline)
        .map_err(|err| fail(format!("free the allocation: {err}")))?;
    if let Some(code) = refresh.error {
        return Err(fail(format!("free the allocation: error {code}")));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(text: &str) -> SocketAddr {
        text.parse().unwrap()
    }

    #[test]
    fn an_unspecified_ipv4_address_maps_to_loopback() {
        let mapped = local(addr("0.0.0.0:8080"));

        assert_eq!(mapped, addr("127.0.0.1:8080"));
    }

    #[test]
    fn an_unspecified_ipv6_address_maps_to_loopback() {
        let mapped = local(addr("[::]:8080"));

        assert_eq!(mapped, addr("[::1]:8080"));
    }

    #[test]
    fn a_specified_address_is_kept() {
        let mapped = local(addr("10.0.0.5:80"));

        assert_eq!(mapped, addr("10.0.0.5:80"));
    }

    #[test]
    fn a_200_status_line_passes() {
        let lines = ["HTTP/1.1 200 OK\r\n", "HTTP/1.0 200 OK\r\n"];

        let results: Vec<bool> = lines.iter().map(|line| is_ok(line)).collect();

        assert_eq!(results, [true, true], "{lines:?}");
    }

    #[test]
    fn a_reply_without_a_200_status_line_fails() {
        let lines = [
            "HTTP/1.1 503 Service Unavailable\r\n",
            "HTTP/1.1 2000\r\n",
            "SSH-2.0-OpenSSH 200\r\n",
            "",
        ];

        let results: Vec<bool> = lines.iter().map(|line| is_ok(line)).collect();

        assert_eq!(results, [false; 4], "{lines:?}");
    }

    fn turn_url(url: &str) -> Option<(String, u16, bool)> {
        Turn::parse(url).map(|turn| (turn.host, turn.port, turn.tcp))
    }

    #[test]
    fn turn_urls_with_a_host_port_and_transport_parse() {
        let urls = [
            "turn:relay.example:3478?transport=udp",
            "turn:relay.example?transport=tcp",
            "turn:203.0.113.7:5349",
            "turn:[2001:db8::1]:3479?transport=tcp",
            "turn:[2001:db8::1]",
        ];

        let parsed: Vec<Option<(String, u16, bool)>> = urls.iter().map(|url| turn_url(url)).collect();

        assert_eq!(parsed[0], Some(("relay.example".into(), 3478, false)));
        assert_eq!(parsed[1], Some(("relay.example".into(), 3478, true)));
        assert_eq!(parsed[2], Some(("203.0.113.7".into(), 5349, false)));
        assert_eq!(parsed[3], Some(("2001:db8::1".into(), 3479, true)));
        assert_eq!(parsed[4], Some(("2001:db8::1".into(), 3478, false)));
    }

    #[test]
    fn a_turn_url_that_is_not_a_plain_turn_url_does_not_parse() {
        let urls = [
            "turns:relay.example",
            "turn:relay.example:http",
            "turn:relay.example?transport=sctp",
            "turn::3478",
        ];

        let parsed: Vec<Option<(String, u16, bool)>> = urls.iter().map(|url| turn_url(url)).collect();

        assert_eq!(parsed, [None, None, None, None], "{urls:?}");
    }

    fn soon() -> Instant {
        Instant::now() + BUDGET
    }

    #[test]
    fn an_http_probe_of_a_closed_port_fails_within_the_budget() {
        let closed = TcpStream::connect("127.0.0.1:1").map(|_| ()).err();
        let start = Instant::now();

        let result = http("127.0.0.1:1".parse().unwrap(), start + HTTP_BUDGET);
        let elapsed = start.elapsed();

        assert!(closed.is_some(), "port 1 is closed on this machine");
        assert!(result.is_err());
        assert!(elapsed < HTTP_BUDGET);
    }

    #[test]
    fn a_turn_allocation_to_a_closed_port_reports_the_binding_failure() {
        let server = Turn::parse("turn:127.0.0.1:1").unwrap();

        let failure = turn(&server, b"secret", soon()).unwrap_err();
        let binding = matches!(&failure, Failure::Turn(message) if message.starts_with("turn:127.0.0.1:1: binding:"));

        assert!(binding, "{failure:?}");
        assert_eq!(failure.code(), 3);
    }

    // The loopback coturn of web/scripts/coturn.sh on 3481, which takes the shared secret E2E_TURN_SECRET: start
    // it, then `cargo test -- --ignored`.
    const LOOPBACK: &str = "turn:127.0.0.1:3481";
    const RELAY_PORTS: usize = 40;

    fn loopback_secret() -> String {
        std::env::var("E2E_TURN_SECRET").unwrap_or_else(|_| "e2e-loopback-turn-secret-0123456789".into())
    }

    // The rounds only mean something as a sequence: each allocation must be free again for the next round, or the
    // coturn's relay ports would run out partway through.
    #[test]
    #[ignore = "needs web/scripts/coturn.sh start"]
    fn allocates_and_frees_on_a_coturn_sharing_the_secret() {
        let secret = loopback_secret();

        // One scenario: only back-to-back rounds prove the coturn frees each allocation before its ports run out.
        for transport in ["udp", "tcp"] {
            let server = Turn::parse(&format!("{LOOPBACK}?transport={transport}")).unwrap();
            // Two rounds of as many checks as the coturn has relay ports. It frees a zero-lifetime allocation on its
            // next timer tick, within a second; one left to expire would hold its port for ten minutes.
            for round in 0..2 {
                for check in 0..RELAY_PORTS {
                    turn(&server, secret.as_bytes(), soon())
                        .unwrap_or_else(|failure| panic!("{transport} round {round} check {check}: {failure:?}"));
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    }

    #[test]
    #[ignore = "needs web/scripts/coturn.sh start"]
    fn another_secret_is_rejected() {
        let server = Turn::parse(LOOPBACK).unwrap();
        let failure = turn(&server, b"not-the-secret-coturn-was-given-0123", soon()).unwrap_err();
        let message = format!("{LOOPBACK}: credential rejected: TURN_SECRET differs from coturn's");

        assert_eq!(failure, Failure::Secret(message));
        assert_eq!(failure.code(), 4);
    }
}
