//! The few STUN and TURN messages the health check sends (RFC 8489, RFC 8656): requests with plain attributes and
//! an optional MESSAGE-INTEGRITY, and the reply's error code and attributes. No XOR-mapped addresses, no FINGERPRINT.

use hmac::{Hmac, KeyInit, Mac};
use md5::{Digest, Md5};
use sha1::Sha1;

pub const BINDING: u16 = 0x0001;
pub const ALLOCATE: u16 = 0x0003;
pub const REFRESH: u16 = 0x0004;

pub const USERNAME: u16 = 0x0006;
const MESSAGE_INTEGRITY: u16 = 0x0008;
const ERROR_CODE: u16 = 0x0009;
pub const LIFETIME: u16 = 0x000D;
pub const REALM: u16 = 0x0014;
pub const NONCE: u16 = 0x0015;
pub const REQUESTED_TRANSPORT: u16 = 0x0019;

const MAGIC: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];
pub const HEADER: usize = 20;
const SUCCESS: u16 = 0x0100;
const ERROR: u16 = 0x0110;

/// A request of `method` with `attributes` in order, signed with `key` when given.
pub fn request(method: u16, id: [u8; 12], attributes: &[(u16, &[u8])], key: Option<&[u8]>) -> Vec<u8> {
    let mut message = Vec::with_capacity(128);
    message.extend_from_slice(&method.to_be_bytes());
    message.extend_from_slice(&[0, 0]);
    message.extend_from_slice(&MAGIC);
    message.extend_from_slice(&id);
    for (kind, value) in attributes {
        message.extend_from_slice(&kind.to_be_bytes());
        message.extend_from_slice(&(value.len() as u16).to_be_bytes());
        message.extend_from_slice(value);
        message.resize(message.len().next_multiple_of(4), 0);
    }
    if let Some(key) = key {
        // The integrity covers the header with the length already counting the MESSAGE-INTEGRITY attribute.
        set_length(&mut message, 24);
        let mut mac = Hmac::<Sha1>::new_from_slice(key).expect("HMAC takes any key length");
        mac.update(&message);
        message.extend_from_slice(&MESSAGE_INTEGRITY.to_be_bytes());
        message.extend_from_slice(&20u16.to_be_bytes());
        message.extend_from_slice(&mac.finalize().into_bytes());
    }
    set_length(&mut message, 0);

    message
}

fn set_length(message: &mut [u8], extra: usize) {
    let length = (message.len() - HEADER + extra) as u16;
    message[2..4].copy_from_slice(&length.to_be_bytes());
}

/// The long-term credential key: MD5(username ":" realm ":" password).
pub fn long_term_key(username: &str, realm: &[u8], password: &str) -> [u8; 16] {
    // MD5 is what the TURN long-term credential mechanism specifies; the key only authenticates to coturn.
    // nosemgrep: rust.lang.security.insecure-hashes.insecure-hashes
    let mut md5 = Md5::new();
    md5.update(username.as_bytes());
    md5.update(b":");
    md5.update(realm);
    md5.update(b":");
    md5.update(password.as_bytes());

    md5.finalize().into()
}

/// The length a message with this header has in total, header included.
pub fn length(header: &[u8; HEADER]) -> usize {
    HEADER + usize::from(u16::from_be_bytes([header[2], header[3]]))
}

/// A response to one request: `error` is the ERROR-CODE of an error response, `None` for success.
pub struct Reply {
    pub error: Option<u16>,
    attributes: Vec<(u16, Vec<u8>)>,
}

impl Reply {
    /// The response to the request of `method` with `id`, or `None` when `bytes` is anything else.
    pub fn parse(bytes: &[u8], method: u16, id: [u8; 12]) -> Option<Reply> {
        let header: &[u8; HEADER] = bytes.get(..HEADER)?.try_into().ok()?;
        let kind = u16::from_be_bytes([header[0], header[1]]);
        if header[4..8] != MAGIC || header[8..] != id || bytes.len() < length(header) {
            return None;
        }
        if kind != method | SUCCESS && kind != method | ERROR {
            return None;
        }

        let mut attributes = vec![];
        let mut rest = &bytes[HEADER..length(header)];
        while rest.len() >= 4 {
            let attribute = u16::from_be_bytes([rest[0], rest[1]]);
            let size = usize::from(u16::from_be_bytes([rest[2], rest[3]]));
            let value = rest.get(4..4 + size)?;
            attributes.push((attribute, value.to_vec()));
            rest = rest.get((4 + size).next_multiple_of(4)..).unwrap_or_default();
        }
        let error = (kind == method | ERROR).then(|| {
            let code = attributes.iter().find(|(attribute, _)| *attribute == ERROR_CODE);
            code.filter(|(_, value)| value.len() >= 4)
                .map_or(0, |(_, value)| u16::from(value[2] & 0x07) * 100 + u16::from(value[3]))
        });

        Some(Reply { error, attributes })
    }

    pub fn attribute(&self, kind: u16) -> Option<&[u8]> {
        self.attributes.iter().find(|(attribute, _)| *attribute == kind).map(|(_, value)| value.as_slice())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(text: &str) -> Vec<u8> {
        let digits: String = text.split_whitespace().collect();
        (0..digits.len()).step_by(2).map(|i| u8::from_str_radix(&digits[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn signs_rfc5769_long_term_sample_request() {
        // RFC 5769 2.4: username, nonce, realm, then MESSAGE-INTEGRITY keyed with the long-term key.
        let expected = hex(
            "0001 0060 2112a442 78ad3433 c6ad72c0 29da412e
             0006 0012 e3839ee3 8388e383 aae38383 e382afe3 82b90000
             0015 001c 662f2f34 39396b39 35346436 4f4c3334 6f4c3946 53547679 36347341
             0014 000b 6578616d 706c652e 6f726700
             0008 0014 f6702465 6dd64a3e 02b8e071 2e85c9a2 8ca89666",
        );
        let username = "マトリックス";
        let key = long_term_key(username, b"example.org", "TheMatrIX");
        let id = expected[8..20].try_into().unwrap();
        let attributes: [(u16, &[u8]); 3] = [
            (USERNAME, username.as_bytes()),
            (NONCE, b"f//499k954d6OL34oL9FSTvy64sA"),
            (REALM, b"example.org"),
        ];

        assert_eq!(request(BINDING, id, &attributes, Some(&key)), expected);
    }

    #[test]
    fn unsigned_request_pads_attributes() {
        let message = request(ALLOCATE, [7; 12], &[(REQUESTED_TRANSPORT, &[17, 0, 0, 0]), (USERNAME, b"abcde")], None);
        assert_eq!(message.len(), HEADER + 8 + 12);
        assert_eq!(&message[..4], &[0x00, 0x03, 0x00, 0x14]);
        assert_eq!(&message[HEADER + 8 + 4..], b"abcde\0\0\0");
    }

    fn response(kind: u16, id: [u8; 12], attributes: &[(u16, &[u8])]) -> Vec<u8> {
        let mut message = request(kind, id, attributes, None);
        message[..2].copy_from_slice(&kind.to_be_bytes());
        message
    }

    #[test]
    fn reads_error_code_realm_and_nonce() {
        let id = [3; 12];
        let bytes = response(ALLOCATE | ERROR, id, &[(ERROR_CODE, &[0, 0, 4, 1]), (REALM, b"e2e"), (NONCE, b"n0nce")]);
        let reply = Reply::parse(&bytes, ALLOCATE, id).unwrap();
        assert_eq!(reply.error, Some(401));
        assert_eq!(reply.attribute(REALM), Some(&b"e2e"[..]));
        assert_eq!(reply.attribute(NONCE), Some(&b"n0nce"[..]));
        assert_eq!(reply.attribute(USERNAME), None);
    }

    #[test]
    fn success_has_no_error() {
        let id = [4; 12];
        assert_eq!(Reply::parse(&response(BINDING | SUCCESS, id, &[]), BINDING, id).unwrap().error, None);
    }

    #[test]
    fn rejects_other_transactions_methods_and_truncated_messages() {
        let id = [5; 12];
        let bytes = response(ALLOCATE | SUCCESS, id, &[(LIFETIME, &[0, 0, 2, 88])]);
        assert!(Reply::parse(&bytes, ALLOCATE, [6; 12]).is_none(), "another transaction");
        assert!(Reply::parse(&bytes, REFRESH, id).is_none(), "another method");
        assert!(Reply::parse(&request(ALLOCATE, id, &[], None), ALLOCATE, id).is_none(), "a request");
        assert!(Reply::parse(&bytes[..bytes.len() - 1], ALLOCATE, id).is_none(), "truncated");
        assert!(Reply::parse(&bytes[..10], ALLOCATE, id).is_none(), "short header");
    }
}
