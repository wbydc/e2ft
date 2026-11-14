// Builds the frontend into web/dist so `cargo build` / `cargo run` embed it, and writes the server's copies
// of the build-time settings to $OUT_DIR/settings.rs. web/scripts/config.mjs checks the frontend's.
use std::{env, fs, path::Path, process::Command};

/// Every build-time setting: a change rebuilds the embedded frontend too.
const SETTINGS: [&str; 15] = [
    "CHUNK_SIZE",
    "WINDOW",
    "MAX_DIRECT",
    "TURN_QUOTA",
    "BUFFER_HIGH",
    "BUFFER_LOW",
    "STEP_MS",
    "GAIN",
    "LANE_OPEN_MS",
    "ACK_EVERY",
    "ACK_MS",
    "ACCESS_LEN",
    "SECRET_LEN",
    "KEEP_ALIVES",
    "KEEP_ALIVE",
];

fn npm(args: &[&str]) {
    let status = Command::new("npm")
        .args(args)
        .current_dir("web")
        .status()
        .expect("npm not found: install Node.js to build the frontend");
    assert!(status.success(), "`npm {}` failed in web/", args.join(" "));
}

/// The env override or the default, as in web/src/config.ts.
fn setting(name: &str, default: &str) -> String {
    env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or(default.to_owned())
}

/// Bounds as in web/scripts/config.mjs; a bad value fails the build naming the variable.
fn int(name: &str, text: &str, min: u64, max: u64) -> u64 {
    match text.trim().parse::<u64>() {
        Ok(v) if (min..=max).contains(&v) => v,
        _ => panic!("{name}: {text}, expected an integer from {min} to {max}"),
    }
}

fn write_settings() {
    let access_len = int("ACCESS_LEN", &setting("ACCESS_LEN", "8"), 6, 16);
    let list = setting("KEEP_ALIVES", "0,60,300,900,1800");
    let keep_alives: Vec<u64> = list
        .split(',')
        .map(|v| int("KEEP_ALIVES", v, 0, 7200))
        .collect();
    // The invite carries the keep-alive as a 3-bit index.
    assert!(
        keep_alives.len() <= 8 && keep_alives.windows(2).all(|w| w[0] < w[1]),
        "KEEP_ALIVES: {list}, expected at most 8 ascending distinct seconds"
    );
    let keep_alive = int("KEEP_ALIVE", &setting("KEEP_ALIVE", "300"), 0, 7200);
    assert!(
        keep_alives.contains(&keep_alive),
        "KEEP_ALIVE: {keep_alive}, expected one of KEEP_ALIVES ({list})"
    );

    let out = Path::new(&env::var("OUT_DIR").unwrap()).join("settings.rs");
    let code = format!(
        "const ACCESS_LEN: usize = {access_len};\nconst KEEP_ALIVES: &[u64] = &{keep_alives:?};\nconst KEEP_ALIVE: u64 = {keep_alive};\n"
    );
    fs::write(out, code).unwrap();
}

fn main() {
    println!("cargo:rerun-if-env-changed=E2FT_WEB_PREBUILT");
    for name in SETTINGS {
        println!("cargo:rerun-if-env-changed={name}");
    }
    write_settings();
    // The Dockerfile builds web/dist in its Node stage and sets this, so the Rust stage needs no npm.
    if env::var_os("E2FT_WEB_PREBUILT").is_some() {
        return;
    }
    for p in [
        "web/src",
        "web/public",
        "web/scripts",
        "web/package.json",
        "web/package-lock.json",
    ] {
        println!("cargo:rerun-if-changed={p}");
    }
    if !Path::new("web/node_modules").exists() {
        npm(&["ci"]);
    }
    npm(&["run", "build"]);
}
