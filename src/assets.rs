//! Every file the server sends, built once at startup: the embedded `web/dist/`, then the optional
//! assets folder over it, then `app.js` and `index.html` rendered with content stamps, slots and the version.
//! Requests read only this table, so no request path ever reaches the filesystem.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use axum::body::Bytes;
use rust_embed::RustEmbed;
use sha2::{Digest, Sha256};

#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct Embedded;

pub(crate) struct Asset {
    pub(crate) bytes: Bytes,
    pub(crate) mime: String,
    pub(crate) hash: [u8; 32],
}

impl Asset {
    fn new(bytes: Bytes, mime: String) -> Asset {
        let hash = Sha256::digest(&bytes).into();
        Asset { bytes, mime, hash }
    }

    /// The `?v=` stamp: the first 12 hex chars of the SHA-256.
    pub(crate) fn stamp(&self) -> String {
        self.hash[..6].iter().map(|b| format!("{b:02x}")).collect()
    }
}

pub(crate) struct Assets {
    files: HashMap<String, Asset>,
}

impl Assets {
    /// `dir` is `ASSETS_DIR`: `public/` files are served over the embedded ones at the same path, and
    /// `slots/<name>.html` fills `<!-- slot:<name> -->` in `index.html`. Any problem with it is an error, so a broken
    /// mount never serves a half-branded page.
    pub(crate) fn load(dir: Option<&Path>) -> Result<Assets, String> {
        let mut files: HashMap<String, Asset> = Embedded::iter()
            .map(|path| {
                let file = Embedded::get(&path).expect("listed by iter");
                let bytes = match file.data {
                    std::borrow::Cow::Borrowed(data) => Bytes::from_static(data),
                    std::borrow::Cow::Owned(data) => Bytes::from(data),
                };
                let asset = Asset {
                    bytes,
                    mime: file.metadata.mimetype().to_owned(),
                    hash: file.metadata.sha256_hash(),
                };

                (path.into_owned(), asset)
            })
            .collect();
        let mut slots = HashMap::new();

        if let Some(dir) = dir {
            std::fs::read_dir(dir).map_err(|err| format!("ASSETS_DIR {}: {err}", dir.display()))?;
            let public = dir.join("public");
            if public.exists() {
                for (path, file) in walk(&public)? {
                    let bytes = read(&file)?;
                    let mime = mime_guess::from_path(&path)
                        .first_or_octet_stream()
                        .to_string();
                    files.insert(path, Asset::new(bytes.into(), mime));
                }
            }
            let slot_dir = dir.join("slots");
            if slot_dir.exists() {
                for (name, file) in walk(&slot_dir)? {
                    let Some(name) = name.strip_suffix(".html") else {
                        continue;
                    };
                    let markup = String::from_utf8(read(&file)?)
                        .map_err(|_| format!("{} is not UTF-8", file.display()))?;
                    slots.insert(name.to_owned(), markup.trim().to_owned());
                }
            }
        }

        let app = stamp_lazy_imports(text(&files, "app.js")?, &files)?;
        replace(&mut files, "app.js", app);
        let index = render_index(text(&files, "index.html")?, &slots, &files)?;
        replace(&mut files, "index.html", index);

        Ok(Assets { files })
    }

    pub(crate) fn get(&self, path: &str) -> Option<&Asset> {
        self.files.get(path)
    }

    /// The legal pages come only from the assets folder; without them /terms and /privacy are not routed (404).
    pub(crate) fn has_legal(&self) -> bool {
        self.files.contains_key("terms.html") && self.files.contains_key("privacy.html")
    }
}

/// Every file under `root` as (path relative to `root` with `/`, full path). Symlinks are followed and names starting
/// with `.` skipped: a ConfigMap volume holds `..data` and `..<timestamp>` entries and symlinks every key.
fn walk(root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let mut found = Vec::new();
    let mut pending = vec![(String::new(), root.to_path_buf())];

    while let Some((prefix, dir)) = pending.pop() {
        let entries = std::fs::read_dir(&dir).map_err(|err| format!("{}: {err}", dir.display()))?;
        for entry in entries {
            let path = entry
                .map_err(|err| format!("{}: {err}", dir.display()))?
                .path();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| format!("{}: name is not UTF-8", path.display()))?;
            if name.starts_with('.') {
                continue;
            }
            let relative = format!("{prefix}{name}");
            if std::fs::metadata(&path)
                .map_err(|err| format!("{}: {err}", path.display()))?
                .is_dir()
            {
                pending.push((format!("{relative}/"), path));
            } else {
                found.push((relative, path));
            }
        }
    }

    Ok(found)
}

/// Swaps a rendered file's bytes in, keeping its MIME type.
fn replace(files: &mut HashMap<String, Asset>, path: &str, rendered: String) {
    let mime = files[path].mime.clone();
    files.insert(path.into(), Asset::new(rendered.into(), mime));
}

fn read(file: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(file).map_err(|err| format!("{}: {err}", file.display()))
}

fn text<'a>(files: &'a HashMap<String, Asset>, path: &str) -> Result<&'a str, String> {
    let asset = files.get(path).ok_or_else(|| format!("{path} missing"))?;

    std::str::from_utf8(&asset.bytes).map_err(|_| format!("{path} is not UTF-8"))
}

/// app.js loads jsqr.js and ristretto.js lazily; their URLs carry the content stamp too.
fn stamp_lazy_imports(app: &str, files: &HashMap<String, Asset>) -> Result<String, String> {
    let mut app = app.to_owned();
    for name in ["jsqr.js", "ristretto.js"] {
        let lazy = format!("\"/{name}\"");
        if app.matches(&lazy).count() != 1 {
            return Err(format!("expected {lazy} once in app.js"));
        }
        let asset = files.get(name).ok_or_else(|| format!("{name} missing"))?;
        app = app.replace(&lazy, &format!("\"/{name}?v={}\"", asset.stamp()));
    }

    Ok(app)
}

/// Slots first, so slot markup gets stamps too; then `?v=<stamp>` on every local `src`/`href` that names a file
/// (a cache never pairs a new page with an old script or stylesheet); then the version.
fn render_index(
    html: &str,
    slots: &HashMap<String, String>,
    files: &HashMap<String, Asset>,
) -> Result<String, String> {
    let html = fill_slots(html, slots)?;
    let html = stamp_urls(&html, files);
    for marker in ["__VERSION__", "__CHANGELOG__"] {
        if html.matches(marker).count() != 1 {
            return Err(format!("expected {marker} once in index.html"));
        }
    }
    let changelog = concat!(env!("CARGO_PKG_REPOSITORY"), "/blob/v", env!("CARGO_PKG_VERSION"), "/CHANGELOG.md");

    Ok(html.replace("__CHANGELOG__", changelog).replace("__VERSION__", env!("CARGO_PKG_VERSION")))
}

/// Replaces each `<!-- slot:NAME -->default<!-- /slot:NAME -->` with the slot's markup, or the trimmed default when
/// the folder has none, and drops the markers. A slot file that names no slot, or a marker without its pair, is an
/// error.
fn fill_slots(html: &str, slots: &HashMap<String, String>) -> Result<String, String> {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    let mut used = Vec::new();

    while let Some(start) = rest.find("<!-- slot:") {
        out.push_str(&rest[..start]);
        let after = &rest[start + "<!-- slot:".len()..];
        let name = after.split(" -->").next().filter(|name| {
            !name.is_empty()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        });
        let Some(name) = name else {
            return Err("unbalanced slot marker in index.html".into());
        };
        let body = &after[name.len() + " -->".len()..];
        let close = format!("<!-- /slot:{name} -->");
        let Some(end) = body.find(&close) else {
            return Err("unbalanced slot marker in index.html".into());
        };
        out.push_str(slots.get(name).map_or(body[..end].trim(), String::as_str));
        used.push(name);
        rest = &body[end + close.len()..];
    }
    out.push_str(rest);

    let mut unknown: Vec<&str> = slots
        .keys()
        .map(String::as_str)
        .filter(|name| !used.contains(name))
        .collect();
    if !unknown.is_empty() {
        unknown.sort();
        return Err(format!("slots not in index.html: {}", unknown.join(", ")));
    }
    if out.contains("<!-- /slot:") {
        return Err("unbalanced slot marker in index.html".into());
    }

    Ok(out)
}

fn stamp_urls(html: &str, files: &HashMap<String, Asset>) -> String {
    let mut out = String::with_capacity(html.len() + 512);
    let mut rest = html;

    while let Some(at) = rest.find("=\"/") {
        let (before, after) = rest.split_at(at + "=\"/".len());
        out.push_str(before);
        rest = after;
        let attribute = &before[..at];
        if !is_attribute(attribute, "src") && !is_attribute(attribute, "href") {
            continue;
        }
        let Some(end) = rest.find('"') else { continue };
        let path = &rest[..end];
        if path.contains(['?', '#']) {
            continue;
        }
        if let Some(asset) = files.get(path) {
            out.push_str(path);
            out.push_str("?v=");
            out.push_str(&asset.stamp());
            rest = &rest[end..];
        }
    }
    out.push_str(rest);

    out
}

/// `text` ends with the attribute `name` as a whole word (so `src` but also `data-src`, as a regex `\bsrc` would).
fn is_attribute(text: &str, name: &str) -> bool {
    text.strip_suffix(name)
        .is_some_and(|head| !head.ends_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The sample folder the docs describe and the e2e legal spec serves.
    pub(crate) fn sample() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("web/tests/assets")
    }

    fn scratch(name: &str) -> PathBuf {
        // Test-only scratch folder, wiped first; the server never writes to the temp dir.
        // nosemgrep: rust.lang.security.temp-dir.temp-dir
        let dir = std::env::temp_dir().join(format!("e2ft-assets-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("public")).unwrap();
        std::fs::create_dir_all(dir.join("slots")).unwrap();
        dir
    }

    fn page(assets: &Assets) -> &str {
        std::str::from_utf8(&assets.get("index.html").unwrap().bytes).unwrap()
    }

    #[test]
    fn without_a_folder_the_defaults_stay_and_the_markers_go() {
        let assets = Assets::load(None).unwrap();
        let html = page(&assets);

        assert!(!html.contains("<!-- slot:") && !html.contains("<!-- /slot:"));
        assert!(html.contains("<span class=\"brand\">e2ft</span>"));
        assert!(!html.contains("__VERSION__") && html.contains(env!("CARGO_PKG_VERSION")));
        let version = env!("CARGO_PKG_VERSION");
        let link = format!("<a class=\"ui-muted\" href=\"https://github.com/wbydc/e2ft/blob/v{version}/CHANGELOG.md\"");
        assert!(html.contains(&link), "the version links to its changelog");
        assert!(!assets.has_legal());
    }

    #[test]
    fn the_folder_overrides_files_and_stamps_follow_the_new_bytes() {
        let neutral = Assets::load(None).unwrap();
        let branded = Assets::load(Some(&sample())).unwrap();
        let favicon = branded.get("ui/favicon.svg").unwrap();

        assert_eq!(
            favicon.bytes.as_ref(),
            std::fs::read(sample().join("public/ui/favicon.svg")).unwrap()
        );
        assert_ne!(favicon.hash, neutral.get("ui/favicon.svg").unwrap().hash);
        assert_eq!(favicon.mime, "image/svg+xml");
        assert!(page(&branded).contains(&format!("/ui/favicon.svg?v={}\"", favicon.stamp())));
        assert!(page(&branded).contains("data-legal=\"terms\""));
        assert!(branded.has_legal());
    }

    #[test]
    fn stamps_cover_index_and_the_lazy_imports() {
        let assets = Assets::load(None).unwrap();
        let app = std::str::from_utf8(&assets.get("app.js").unwrap().bytes).unwrap();

        for name in ["jsqr.js", "ristretto.js"] {
            assert!(app.contains(&format!(
                "\"/{name}?v={}\"",
                assets.get(name).unwrap().stamp()
            )));
        }
        assert!(page(&assets).contains(&format!(
            "src=\"/app.js?v={}\"",
            assets.get("app.js").unwrap().stamp()
        )));
        assert_eq!(
            assets.get("app.js").unwrap().hash,
            <[u8; 32]>::from(Sha256::digest(app.as_bytes()))
        );
    }

    #[test]
    fn only_local_files_get_stamped() {
        let files = HashMap::from([(
            "a.css".to_owned(),
            Asset::new(Bytes::from_static(b"a"), "text/css".into()),
        )]);
        let stamp = files["a.css"].stamp();

        assert_eq!(
            stamp_urls(r#"<link href="/a.css">"#, &files),
            format!(r#"<link href="/a.css?v={stamp}">"#)
        );
        assert_eq!(
            stamp_urls(r#"<img data-src="/a.css">"#, &files),
            format!(r#"<img data-src="/a.css?v={stamp}">"#)
        );
        for kept in [
            r#"<a href="/a.css?x=1">"#,
            r#"<a href="/b.css">"#,
            r#"<a xhref="/a.css">"#,
            r#"<a href="/">"#,
        ] {
            assert_eq!(stamp_urls(kept, &files), kept);
        }
    }

    #[test]
    fn bad_folders_stop_startup() {
        assert!(
            Assets::load(Some(Path::new("/nonexistent-e2ft-assets")))
                .err()
                .unwrap()
                .contains("ASSETS_DIR")
        );

        let dir = scratch("unknown");
        std::fs::write(dir.join("slots/unknown.html"), "x").unwrap();
        assert_eq!(
            Assets::load(Some(&dir)).err().unwrap(),
            "slots not in index.html: unknown"
        );
        std::fs::remove_dir_all(dir).unwrap();

        let slots = HashMap::new();
        assert!(fill_slots("<!-- slot:a -->x", &slots).is_err());
        assert!(fill_slots("x<!-- /slot:a -->", &slots).is_err());
        assert_eq!(
            fill_slots("<!-- slot:a --> x <!-- /slot:a -->!", &slots).unwrap(),
            "x!"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_configmap_layout_loads_without_its_dot_entries() {
        let dir = scratch("configmap");
        std::fs::create_dir_all(dir.join("..2026_11_09/public/ui")).unwrap();
        std::fs::write(dir.join("..2026_11_09/public/ui/favicon.svg"), "<svg/>").unwrap();
        std::fs::write(dir.join("public/.hidden"), "x").unwrap();
        std::os::unix::fs::symlink(dir.join("..2026_11_09"), dir.join("..data")).unwrap();
        std::os::unix::fs::symlink(dir.join("..data/public/ui"), dir.join("public/ui")).unwrap();
        let assets = Assets::load(Some(&dir)).unwrap();

        assert_eq!(
            assets.get("ui/favicon.svg").unwrap().bytes.as_ref(),
            b"<svg/>"
        );
        assert!(
            assets.get(".hidden").is_none() && assets.get("..data/public/ui/favicon.svg").is_none()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
