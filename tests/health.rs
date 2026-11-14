//! The built binary's `--health` against a server it started, then against the same port with nothing listening.

use std::{
    net::TcpListener,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const BINARY: &str = env!("CARGO_BIN_EXE_e2ft");

fn health(addr: &str) -> (Option<i32>, String, Duration) {
    let start = Instant::now();
    let output = Command::new(BINARY)
        .arg("--health")
        .env("ADDR", addr)
        .env_remove("TURN_URLS")
        .output()
        .expect("run e2ft --health");

    (output.status.code(), String::from_utf8_lossy(&output.stderr).into_owned(), start.elapsed())
}

#[test]
fn passes_while_the_server_answers_and_fails_fast_when_it_stops() {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let mut server = Command::new(BINARY)
        .env("ADDR", format!("0.0.0.0:{port}"))
        .env_remove("TURN_URLS")
        .env_remove("METRICS")
        .env_remove("ASSETS_DIR")
        .stdout(Stdio::null())
        .spawn()
        .expect("start e2ft");

    let ready = Instant::now() + Duration::from_secs(10);
    while health(&format!("127.0.0.1:{port}")).0 != Some(0) {
        assert!(Instant::now() < ready, "server did not come up");
        std::thread::sleep(Duration::from_millis(100));
    }
    let (code, stderr, _) = health(&format!("0.0.0.0:{port}"));
    assert_eq!(code, Some(0), "the server's own unspecified ADDR: {stderr}");
    assert!(stderr.is_empty(), "silent on success: {stderr}");

    server.kill().unwrap();
    server.wait().unwrap();
    let (code, stderr, took) = health(&format!("0.0.0.0:{port}"));
    assert_eq!(code, Some(1));
    assert!(stderr.starts_with("health: server on 127.0.0.1:"), "{stderr}");
    assert!(took < Duration::from_secs(2), "{took:?}");
}
