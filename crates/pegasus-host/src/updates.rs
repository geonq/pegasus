//! Over-the-air updates for the phone app (expo-updates protocol v1), served read-only and without
//! a token next to the remote API, so only on 127.0.0.1 and the Tailscale address:
//!   GET /v1/updates/manifest        multipart/mixed with the signed manifest, or 204 when none fits
//!   GET /v1/updates/assets/<file>   a content-addressed bundle or asset
//! Files come from `<.state>/mobile-updates`, written by apps/mobile/scripts/publish-update.mjs
//! (see its header for the layout). Updates are signed there; the phone checks the signature, so
//! anyone who can reach these routes can read the app's JS but never change it.
use bytes::Bytes;
use http_body_util::Full;
use hyper::header::{HeaderMap, HeaderValue};
use hyper::{Response, StatusCode};
use std::path::Path;

const MAX_LATEST_BYTES: u64 = 64 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 4 * 1024;
const MAX_ASSET_BYTES: u64 = 64 * 1024 * 1024;
const BOUNDARY: &str = "pegasus-update-0a8f3c";

pub type Reply = Response<Full<Bytes>>;

pub fn is_update_path(path: &str) -> bool {
    path == "/v1/updates/manifest" || path.starts_with("/v1/updates/assets/")
}

/// A lowercase UUID: the only update id that may become a directory name.
fn safe_update_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}

/// `<64 lowercase hex>.<1-8 lowercase alnum>`: no separators, dots or drive letters can get through.
fn safe_asset_name(name: &str) -> bool {
    let Some((hash, ext)) = name.split_once('.') else { return false };
    hash.len() == 64
        && hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && (1..=8).contains(&ext.len())
        && ext.bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
}

// Kept in step with contentType() in apps/mobile/scripts/update-lib.mjs.
fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "hbc" | "js" | "bundle" => "application/javascript",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

fn reply(status: u16, content_type: &'static str, body: impl Into<Bytes>) -> Reply {
    let mut r = Response::new(Full::new(body.into()));
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let h = r.headers_mut();
    h.insert("content-type", HeaderValue::from_static(content_type));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    r
}

fn problem(status: u16, message: &str) -> Reply {
    crate::info!("update request refused: {status} {message}");
    let mut r = reply(status, "application/json; charset=utf-8", serde_json::json!({ "error": message }).to_string());
    r.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    r
}

/// Reads a file only if it is at most `max` bytes; `Ok(None)` when it does not exist.
async fn read_capped(path: &Path, max: u64) -> Result<Option<Vec<u8>>, String> {
    match tokio::fs::metadata(path).await {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
        Ok(m) if !m.is_file() => return Ok(None),
        Ok(m) if m.len() > max => return Err(format!("{} is larger than {max} bytes", path.display())),
        Ok(_) => {}
    }
    match tokio::fs::read(path).await {
        Ok(b) if b.len() as u64 <= max => Ok(Some(b)),
        Ok(_) => Err(format!("{} grew past {max} bytes", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn header<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

pub async fn handle(dir: &Path, path: &str, headers: &HeaderMap) -> Reply {
    if path == "/v1/updates/manifest" {
        return manifest(dir, headers).await;
    }
    let name = path.strip_prefix("/v1/updates/assets/").unwrap_or("");
    if !safe_asset_name(name) {
        return problem(404, "unknown asset");
    }
    match read_capped(&dir.join("assets").join(name), MAX_ASSET_BYTES).await {
        Ok(Some(bytes)) => {
            let mut r = reply(200, content_type(name), bytes);
            // Named by their sha256: the bytes behind a name never change.
            r.headers_mut().insert("cache-control", HeaderValue::from_static("public, max-age=31536000, immutable"));
            r
        }
        Ok(None) => problem(404, "unknown asset"),
        Err(e) => problem(500, &e),
    }
}

async fn manifest(dir: &Path, headers: &HeaderMap) -> Reply {
    if header(headers, "expo-protocol-version") != Some("1") {
        return problem(400, "expo-protocol-version 1 is required");
    }
    if header(headers, "expo-platform") != Some("ios") {
        return problem(400, "only expo-platform ios is published");
    }
    let Some(runtime) = header(headers, "expo-runtime-version").filter(|r| !r.is_empty() && r.len() <= 256) else {
        return problem(400, "expo-runtime-version is required");
    };
    let latest = match read_capped(&dir.join("latest.json"), MAX_LATEST_BYTES).await {
        Ok(Some(b)) => b,
        Ok(None) => return no_update(),
        Err(e) => return problem(500, &e),
    };
    let latest: serde_json::Map<String, serde_json::Value> = match serde_json::from_slice(&latest) {
        Ok(v) => v,
        Err(e) => return problem(500, &format!("latest.json: {e}")),
    };
    // No update for this native build (another runtime): the phone keeps what it runs.
    let Some(id) = latest.get(runtime).and_then(|v| v.as_str()) else { return no_update() };
    if !safe_update_id(id) {
        return problem(500, "latest.json names an invalid update id");
    }
    let update = dir.join("updates").join(id);
    let (manifest, signature) = match (
        read_capped(&update.join("manifest.json"), MAX_MANIFEST_BYTES).await,
        read_capped(&update.join("signature"), MAX_SIGNATURE_BYTES).await,
    ) {
        (Ok(Some(m)), Ok(Some(s))) => (m, s),
        (Err(e), _) | (_, Err(e)) => return problem(500, &e),
        _ => return problem(500, &format!("update {id} is incomplete")),
    };
    let signature = String::from_utf8_lossy(&signature).trim().to_string();
    if signature.contains(['\r', '\n']) {
        return problem(500, "the update signature is malformed");
    }
    // Byte-exact: the signature covers these bytes, so they are never re-serialised.
    let mut body = Vec::with_capacity(manifest.len() + 1024);
    body.extend_from_slice(format!(
        "--{BOUNDARY}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-disposition: form-data; name=\"manifest\"\r\nexpo-signature: {signature}\r\n\r\n"
    ).as_bytes());
    body.extend_from_slice(&manifest);
    body.extend_from_slice(format!(
        "\r\n--{BOUNDARY}\r\ncontent-type: application/json\r\ncontent-disposition: form-data; name=\"extensions\"\r\n\r\n{{\"assetRequestHeaders\":{{}}}}\r\n--{BOUNDARY}--\r\n"
    ).as_bytes());
    let mut r = reply(200, "multipart/mixed; boundary=pegasus-update-0a8f3c", body);
    protocol_headers(r.headers_mut());
    r
}

fn no_update() -> Reply {
    let mut r = reply(204, "text/plain", Bytes::new());
    protocol_headers(r.headers_mut());
    r
}

fn protocol_headers(h: &mut HeaderMap) {
    h.insert("expo-protocol-version", HeaderValue::from_static("1"));
    h.insert("expo-sfv-version", HeaderValue::from_static("0"));
    h.insert("cache-control", HeaderValue::from_static("private, max-age=0"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    const ID: &str = "0b6f3c9e-5d2a-4f1b-9c3e-7a8d6e5f4c3b";

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pegasus-updates-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("updates").join(ID)).unwrap();
        std::fs::create_dir_all(d.join("assets")).unwrap();
        std::fs::write(d.join("latest.json"), format!(r#"{{"rv1":"{ID}"}}"#)).unwrap();
        std::fs::write(d.join("updates").join(ID).join("manifest.json"), r#"{"id":"x"}"#).unwrap();
        std::fs::write(d.join("updates").join(ID).join("signature"), r#"sig="abc", keyid="main""#).unwrap();
        d
    }

    fn ios(rv: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("expo-protocol-version", HeaderValue::from_static("1"));
        h.insert("expo-platform", HeaderValue::from_static("ios"));
        h.insert("expo-runtime-version", HeaderValue::from_str(rv).unwrap());
        h
    }

    async fn text(r: Reply) -> String {
        String::from_utf8(r.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap()
    }

    #[test]
    fn names_that_could_leave_the_folder_are_refused() {
        let ok = "a".repeat(64) + ".png";
        assert!(safe_asset_name(&ok));
        for bad in [
            "../latest.json".to_string(),
            "a".repeat(64) + ".png/../x",
            "a".repeat(64) + "..png",
            "A".repeat(64) + ".png",
            "a".repeat(63) + ".png",
            "a".repeat(64) + ".",
            "a".repeat(64) + ".toolongext",
            "a".repeat(64) + ".p\\g",
            "a".repeat(64),
            "C:".to_string() + &"a".repeat(62) + ".png",
            String::new(),
        ] {
            assert!(!safe_asset_name(&bad), "{bad}");
        }
        assert!(safe_update_id(ID));
        for bad in ["../x", "0B6F3C9E-5D2A-4F1B-9C3E-7A8D6E5F4C3B", "0b6f3c9e-5d2a-4f1b-9c3e-7a8d6e5f4c3", "0b6f3c9e/5d2a-4f1b-9c3e-7a8d6e5f4c3b"] {
            assert!(!safe_update_id(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn manifest_is_multipart_with_the_signature_and_exact_bytes() {
        let d = dir("manifest");
        let r = handle(&d, "/v1/updates/manifest", &ios("rv1")).await;
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["expo-protocol-version"], "1");
        assert_eq!(r.headers()["expo-sfv-version"], "0");
        assert_eq!(r.headers()["content-type"], "multipart/mixed; boundary=pegasus-update-0a8f3c");
        let body = text(r).await;
        assert!(body.starts_with("--pegasus-update-0a8f3c\r\n"), "{body}");
        assert!(body.contains("name=\"manifest\"\r\nexpo-signature: sig=\"abc\", keyid=\"main\"\r\n\r\n{\"id\":\"x\"}\r\n--pegasus-update-0a8f3c\r\n"), "{body}");
        assert!(body.contains("name=\"extensions\"\r\n\r\n{\"assetRequestHeaders\":{}}"), "{body}");
        // The iOS reader needs CRLF after the close delimiter.
        assert!(body.ends_with("\r\n--pegasus-update-0a8f3c--\r\n"), "{body}");
        let _ = std::fs::remove_dir_all(d);
    }

    #[tokio::test]
    async fn other_runtime_or_nothing_published_is_204_and_bad_requests_400() {
        let d = dir("rv");
        let r = handle(&d, "/v1/updates/manifest", &ios("other")).await;
        assert_eq!(r.status(), 204);
        assert_eq!(r.headers()["expo-protocol-version"], "1");
        let mut android = ios("rv1");
        android.insert("expo-platform", HeaderValue::from_static("android"));
        assert_eq!(handle(&d, "/v1/updates/manifest", &android).await.status(), 400);
        let mut v0 = ios("rv1");
        v0.insert("expo-protocol-version", HeaderValue::from_static("0"));
        assert_eq!(handle(&d, "/v1/updates/manifest", &v0).await.status(), 400);
        assert_eq!(handle(&d, "/v1/updates/manifest", &HeaderMap::new()).await.status(), 400);
        // A tampered latest.json cannot steer the read outside updates/.
        std::fs::write(d.join("latest.json"), r#"{"rv1":"../../secret"}"#).unwrap();
        assert_eq!(handle(&d, "/v1/updates/manifest", &ios("rv1")).await.status(), 500);
        std::fs::remove_file(d.join("latest.json")).unwrap();
        assert_eq!(handle(&d, "/v1/updates/manifest", &ios("rv1")).await.status(), 204);
        let _ = std::fs::remove_dir_all(d);
    }

    #[tokio::test]
    async fn assets_are_served_immutable_and_traversal_is_404() {
        let d = dir("assets");
        let name = "b".repeat(64) + ".hbc";
        std::fs::write(d.join("assets").join(&name), b"bundle").unwrap();
        std::fs::write(d.join("secret.txt"), b"no").unwrap();
        let r = handle(&d, &format!("/v1/updates/assets/{name}"), &HeaderMap::new()).await;
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["content-type"], "application/javascript");
        assert_eq!(r.headers()["cache-control"], "public, max-age=31536000, immutable");
        assert_eq!(text(r).await, "bundle");
        for p in ["/v1/updates/assets/../secret.txt", "/v1/updates/assets/..%2Fsecret.txt", "/v1/updates/assets/", "/v1/updates/assets/x/../../secret.txt"] {
            assert_eq!(handle(&d, p, &HeaderMap::new()).await.status(), 404, "{p}");
        }
        let missing = "c".repeat(64) + ".png";
        assert_eq!(handle(&d, &format!("/v1/updates/assets/{missing}"), &HeaderMap::new()).await.status(), 404);
        let _ = std::fs::remove_dir_all(d);
    }

    #[tokio::test]
    async fn oversized_files_are_refused() {
        let d = dir("big");
        let f = std::fs::File::create(d.join("latest.json")).unwrap();
        f.set_len(MAX_LATEST_BYTES + 1).unwrap();
        assert_eq!(handle(&d, "/v1/updates/manifest", &ios("rv1")).await.status(), 500);
        let _ = std::fs::remove_dir_all(d);
    }
}
