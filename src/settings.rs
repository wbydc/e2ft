//! The tuning settings both halves share: the transfer knobs, the invite lengths and the keep-alive choices. The
//! server reads them from the environment at startup, checks them, and writes them into the page for the frontend
//! (src/assets.rs); web/src/config.ts holds the same defaults for unit tests. A bad value stops the server with a
//! message naming the variable.

use serde::Serialize;

const MIB: u64 = 1024 * 1024;
/// The invite carries the keep-alive as a 3-bit index.
const MAX_KEEP_ALIVES: usize = 8;
/// What the receiver may hold for reordering.
const MAX_WINDOW_BYTES: u64 = 256 * MIB;

/// Field names are the frontend's, so the page reads the JSON as is.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) struct Settings {
    pub(crate) chunk_size: u64,
    pub(crate) window: u64,
    pub(crate) max_direct: u64,
    pub(crate) turn_quota: u64,
    pub(crate) buffer_high: u64,
    pub(crate) buffer_low: u64,
    pub(crate) step_ms: u64,
    pub(crate) gain: f64,
    pub(crate) lane_open_ms: u64,
    pub(crate) ack_every: u64,
    pub(crate) ack_ms: u64,
    pub(crate) access_len: usize,
    pub(crate) secret_len: u64,
    pub(crate) keep_alives: Vec<u64>,
    pub(crate) keep_alive: u64,
}

impl Settings {
    pub(crate) fn from_env() -> Result<Settings, String> {
        Settings::parse(|name| std::env::var(name).ok())
    }

    /// Each setting from `lookup`, blank meaning unset, then the bounds and the checks between settings.
    pub(crate) fn parse(lookup: impl Fn(&str) -> Option<String>) -> Result<Settings, String> {
        let read = |name: &str| lookup(name).map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
        let int = |name: &str, default: u64, min: u64, max: u64| match read(name) {
            None => Ok(default),
            Some(text) => match text.parse::<u64>() {
                Ok(value) if (min..=max).contains(&value) => Ok(value),
                _ => Err(format!("{name}: {text}, expected an integer from {min} to {max}")),
            },
        };

        // An 8-byte frame head and a 16-byte GCM tag keep a chunk's frame within a 256 KiB data channel message.
        let chunk_size = int("CHUNK_SIZE", 64 * 1024, 1024, 262_120)?;
        let window = int("WINDOW", 1024, 16, 65_536)?;
        let max_direct = int("MAX_DIRECT", 8, 1, 16)?;
        let turn_quota = int("TURN_QUOTA", 12, 1, 100)?;
        let buffer_high = int("BUFFER_HIGH", 8 * MIB, 64 * 1024, 64 * MIB)?;
        let buffer_low = int("BUFFER_LOW", MIB, 0, 64 * MIB)?;
        let step_ms = int("STEP_MS", 3000, 500, 60_000)?;
        let gain = match read("GAIN") {
            None => 1.2,
            Some(text) => match text.parse::<f64>() {
                Ok(value) if value > 1.0 && value <= 4.0 => value,
                _ => return Err(format!("GAIN: {text}, expected a number above 1 from 1 to 4")),
            },
        };
        let lane_open_ms = int("LANE_OPEN_MS", 10_000, 1000, 120_000)?;
        let ack_every = int("ACK_EVERY", 32, 1, 65_536)?;
        let ack_ms = int("ACK_MS", 500, 50, 10_000)?;
        let access_len = int("ACCESS_LEN", 8, 6, 16)? as usize;
        // Below 6 chars (30 bits) the CPace password gets too weak to guess online.
        let secret_len = int("SECRET_LEN", 6, 6, 16)?;
        let keep_alives = match read("KEEP_ALIVES") {
            None => vec![0, 60, 300, 900, 1800],
            Some(text) => text
                .split(',')
                .map(|part| match part.trim().parse::<u64>() {
                    Ok(value) if value <= 7200 => Ok(value),
                    _ => Err(format!("KEEP_ALIVES: {text}, expected comma-separated integers from 0 to 7200")),
                })
                .collect::<Result<Vec<u64>, String>>()?,
        };
        let keep_alive = int("KEEP_ALIVE", 300, 0, 7200)?;

        let list = keep_alives.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        if keep_alives.len() > MAX_KEEP_ALIVES || keep_alives.windows(2).any(|pair| pair[1] <= pair[0]) {
            return Err(format!("KEEP_ALIVES: {list}, expected at most {MAX_KEEP_ALIVES} ascending distinct seconds"));
        }
        if !keep_alives.contains(&keep_alive) {
            return Err(format!("KEEP_ALIVE: {keep_alive}, expected one of KEEP_ALIVES ({list})"));
        }
        if buffer_low >= buffer_high {
            return Err(format!("BUFFER_LOW: {buffer_low}, expected below BUFFER_HIGH ({buffer_high})"));
        }
        if window * chunk_size > MAX_WINDOW_BYTES {
            return Err(format!(
                "WINDOW: {window}, expected WINDOW * CHUNK_SIZE ({chunk_size}) at most {MAX_WINDOW_BYTES}"
            ));
        }
        if ack_every > window {
            return Err(format!("ACK_EVERY: {ack_every}, expected at most WINDOW ({window})"));
        }

        Ok(Settings {
            chunk_size,
            window,
            max_direct,
            turn_quota,
            buffer_high,
            buffer_low,
            step_ms,
            gain,
            lane_open_ms,
            ack_every,
            ack_ms,
            access_len,
            secret_len,
            keep_alives,
            keep_alive,
        })
    }
}

impl Default for Settings {
    fn default() -> Settings {
        Settings::parse(|_| None).expect("the defaults pass their own checks")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(pairs: &[(&str, &str)]) -> Result<Settings, String> {
        Settings::parse(|name| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned()))
    }

    #[test]
    fn defaults_match_the_frontend() {
        let json = serde_json::to_value(Settings::default()).unwrap();

        assert_eq!(
            json,
            serde_json::json!({
                "CHUNK_SIZE": 65536, "WINDOW": 1024, "MAX_DIRECT": 8, "TURN_QUOTA": 12, "BUFFER_HIGH": 8_388_608,
                "BUFFER_LOW": 1_048_576, "STEP_MS": 3000, "GAIN": 1.2, "LANE_OPEN_MS": 10000, "ACK_EVERY": 32,
                "ACK_MS": 500, "ACCESS_LEN": 8, "SECRET_LEN": 6, "KEEP_ALIVES": [0, 60, 300, 900, 1800],
                "KEEP_ALIVE": 300
            })
        );
    }

    #[test]
    fn overrides_are_read_and_blank_is_unset() {
        let settings = parse(&[
            ("CHUNK_SIZE", " 131072 "),
            ("GAIN", "1.5"),
            ("KEEP_ALIVES", "0, 120,600"),
            ("KEEP_ALIVE", "120"),
            ("WINDOW", ""),
        ])
        .unwrap();

        assert_eq!(settings.chunk_size, 131_072);
        assert_eq!(settings.gain, 1.5);
        assert_eq!(settings.keep_alives, [0, 120, 600]);
        assert_eq!(settings.keep_alive, 120);
        assert_eq!(settings.window, 1024);
    }

    #[test]
    fn bad_values_name_the_variable_and_the_bounds() {
        let cases: &[(&[(&str, &str)], &str)] = &[
            (&[("CHUNK_SIZE", "1023")], "CHUNK_SIZE: 1023, expected an integer from 1024 to 262120"),
            (&[("CHUNK_SIZE", "262121")], "CHUNK_SIZE: 262121, expected an integer from 1024 to 262120"),
            (&[("MAX_DIRECT", "two")], "MAX_DIRECT: two, expected an integer from 1 to 16"),
            (&[("STEP_MS", "1.5")], "STEP_MS: 1.5, expected an integer from 500 to 60000"),
            (&[("GAIN", "1")], "GAIN: 1, expected a number above 1 from 1 to 4"),
            (&[("GAIN", "4.5")], "GAIN: 4.5, expected a number above 1 from 1 to 4"),
            (&[("SECRET_LEN", "5")], "SECRET_LEN: 5, expected an integer from 6 to 16"),
            (&[("KEEP_ALIVES", "0,x")], "KEEP_ALIVES: 0,x, expected comma-separated integers from 0 to 7200"),
            (&[("KEEP_ALIVES", "0,7201")], "KEEP_ALIVES: 0,7201, expected comma-separated integers from 0 to 7200"),
            (
                &[("KEEP_ALIVES", "0,300,60")],
                "KEEP_ALIVES: 0,300,60, expected at most 8 ascending distinct seconds",
            ),
            (
                &[("KEEP_ALIVES", "0,1,2,3,4,5,6,7,300")],
                "KEEP_ALIVES: 0,1,2,3,4,5,6,7,300, expected at most 8 ascending distinct seconds",
            ),
            (&[("KEEP_ALIVE", "7")], "KEEP_ALIVE: 7, expected one of KEEP_ALIVES (0,60,300,900,1800)"),
            (
                &[("BUFFER_LOW", "8388608")],
                "BUFFER_LOW: 8388608, expected below BUFFER_HIGH (8388608)",
            ),
            (
                &[("WINDOW", "8192"), ("CHUNK_SIZE", "65536")],
                "WINDOW: 8192, expected WINDOW * CHUNK_SIZE (65536) at most 268435456",
            ),
            (&[("WINDOW", "16")], "ACK_EVERY: 32, expected at most WINDOW (16)"),
        ];

        for (pairs, message) in cases {
            assert_eq!(parse(pairs).unwrap_err(), *message, "{pairs:?}");
        }
    }
}

