//! The public HTTP side: the files of `assets::Assets`, stamped asset caching, the legal pages when the assets
//! folder provides them, and the security headers on every response.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};

use crate::{App, web::assets::Assets};

pub(crate) async fn security_headers(mut res: Response) -> Response {
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; \
             base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // Browsers ignore it over plain http, so a local run is unaffected. No includeSubDomains: other hosts under the
    // same domain are not ours to force.
    h.insert(
        header::STRICT_TRANSPORT_SECURITY,
        HeaderValue::from_static("max-age=31536000"),
    );
    // The camera is for the invite scanner and the wake lock keeps a phone awake while sending; nothing else is used.
    h.insert(
        "permissions-policy",
        HeaderValue::from_static(
            "camera=(self), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=(), \
             bluetooth=(), midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(self)",
        ),
    );
    h.insert(
        "cross-origin-opener-policy",
        HeaderValue::from_static("same-origin"),
    );
    // Unstamped URLs must revalidate; stamped ones (?v=<hash>, src/web/assets.rs) set their own long-lived header.
    h.entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-cache"));
    res
}

fn serve(assets: &Assets, path: &str) -> Response {
    match assets.get(path) {
        Some(asset) => (
            [(header::CONTENT_TYPE, asset.mime.clone())],
            asset.bytes.clone(),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

pub(crate) async fn index(State(app): State<Arc<App>>) -> Response {
    serve(&app.assets, "index.html")
}

/// `?lang=<code>` serves `<page>.<code>.html` when the assets folder has that language; no `lang`, an
/// unknown one or one without its file serves the English `<page>.html`.
fn legal(assets: &Assets, uri: Uri, page: &str) -> Response {
    let lang = uri
        .query()
        .and_then(|q| q.split('&').find_map(|p| p.strip_prefix("lang=")))
        .filter(|l| valid_lang(l));
    let translated = lang
        .map(|l| format!("{page}.{l}.html"))
        .filter(|f| assets.get(f).is_some());
    serve(
        assets,
        &translated.unwrap_or_else(|| format!("{page}.html")),
    )
}

/// A language tag such as `ru` or `pt-br`: letters and hyphens only, so it can never name another file.
fn valid_lang(l: &str) -> bool {
    (2..=8).contains(&l.len()) && l.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
}

pub(crate) async fn terms(State(app): State<Arc<App>>, uri: Uri) -> Response {
    legal(&app.assets, uri, "terms")
}

pub(crate) async fn privacy(State(app): State<Arc<App>>, uri: Uri) -> Response {
    legal(&app.assets, uri, "privacy")
}

/// `?v=` is the file's current stamp (`Asset::stamp`).
fn stamped(assets: &Assets, path: &str, query: Option<&str>) -> bool {
    let (Some(v), Some(asset)) = (query.and_then(|q| q.strip_prefix("v=")), assets.get(path))
    else {
        return false;
    };
    v == asset.stamp()
}

pub(crate) async fn asset(State(app): State<Arc<App>>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let mut res = serve(&app.assets, path);
    // A URL stamped with the current content hash never changes; an old page's stale stamp still revalidates.
    if stamped(&app.assets, path, uri.query()) {
        res.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::assets::tests::sample;

    fn app_assets() -> Assets {
        Assets::load(None, &crate::settings::Settings::default()).unwrap()
    }

    #[test]
    fn the_current_content_hash_is_stamped() {
        let assets = app_assets();
        let stamp = assets.get("app.js").unwrap().stamp();

        let matched = stamped(&assets, "app.js", Some(&format!("v={stamp}")));

        assert!(matched);
    }

    #[test]
    fn another_content_hash_is_not_stamped() {
        let assets = app_assets();

        let matched = stamped(&assets, "app.js", Some("v=000000000000"));

        assert!(!matched);
    }

    #[test]
    fn a_short_content_hash_is_not_stamped() {
        let assets = app_assets();
        let stamp = assets.get("app.js").unwrap().stamp();

        let matched = stamped(&assets, "app.js", Some(&format!("v={}", &stamp[..8])));

        assert!(!matched);
    }

    #[test]
    fn a_url_without_a_hash_is_not_stamped() {
        let assets = app_assets();

        let matched = stamped(&assets, "app.js", None);

        assert!(!matched);
    }

    #[test]
    fn a_missing_file_is_not_stamped() {
        let assets = app_assets();
        let stamp = assets.get("app.js").unwrap().stamp();

        let matched = stamped(&assets, "missing.js", Some(&format!("v={stamp}")));

        assert!(!matched);
    }

    #[tokio::test]
    async fn legal_pages_serve_the_right_language() {
        let assets = Assets::load(Some(&sample()), &crate::settings::Settings::default()).unwrap();
        let cases = [
            ("/terms", "terms", "terms.html", "en"),
            ("/terms?lang=ru", "terms", "terms.ru.html", "ru"),
            ("/privacy", "privacy", "privacy.html", "en"),
            ("/privacy?lang=ru", "privacy", "privacy.ru.html", "ru"),
            ("/terms?lang=de", "terms", "terms.html", "en"),
            ("/privacy?lang=de", "privacy", "privacy.html", "en"),
            ("/terms?x=1&lang=ru", "terms", "terms.ru.html", "ru"),
            ("/terms?lang=../index", "terms", "terms.html", "en"),
            ("/terms?lang=RU", "terms", "terms.html", "en"),
        ];

        let mut served = Vec::new();
        for (uri, page, file, lang) in cases {
            let res = legal(&assets, Uri::from_static(uri), page);
            let status = res.status();
            let content_type = res.headers()[header::CONTENT_TYPE].to_str().unwrap().to_owned();
            let body = axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap();
            served.push((uri, file, lang, status, content_type, body));
        }

        for (uri, file, lang, status, content_type, body) in served {
            assert_eq!(status, StatusCode::OK, "{uri}");
            assert_eq!(content_type, "text/html", "{uri}");
            let text = std::str::from_utf8(&body).unwrap();
            assert!(text.contains(&format!("<html lang=\"{lang}\">")), "{uri}");
            assert_eq!(
                text.as_bytes(),
                assets.get(file).unwrap().bytes.as_ref(),
                "{uri}"
            );
        }
    }

    #[tokio::test]
    async fn legal_pages_get_the_page_headers() {
        let assets = Assets::load(Some(&sample()), &crate::settings::Settings::default()).unwrap();
        let res = security_headers(legal(&assets, Uri::from_static("/terms"), "terms")).await;

        assert!(
            res.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("default-src 'self'")
        );
        assert_eq!(res.headers()[header::REFERRER_POLICY], "no-referrer");
        assert_eq!(res.headers()[header::STRICT_TRANSPORT_SECURITY], "max-age=31536000");
        assert_eq!(res.headers()["cross-origin-opener-policy"], "same-origin");
        let permissions = res.headers()["permissions-policy"].to_str().unwrap();
        assert!(permissions.starts_with("camera=(self), microphone=()"), "{permissions}");
    }
}
