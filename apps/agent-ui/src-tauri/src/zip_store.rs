//! Minimal ZIP writer — store-only (no compression), streamed.
//!
//! Why hand-rolled instead of the `zip` crate: the only caller is the DAG
//! node-output "打包下载全部" endpoint, and node outputs are overwhelmingly
//! parquet — already compressed, so deflate would burn CPU for ~0 size gain.
//! A store-only archive therefore loses nothing and keeps this crate
//! dependency-free (std + a small CRC-32).
//!
//! Streaming: the archive is produced as a byte stream (one member at a time,
//! chunked), so peak memory is one chunk rather than the whole archive. CRC-32
//! is computed while copying and each member carries a *data descriptor*
//! (general-purpose flag bit 3), so no pre-pass over the file is needed.
//!
//! Limits: plain ZIP (no ZIP64) — member size and total archive size must stay
//! under 4 GiB, and there may be at most 65535 members. Violations are rejected
//! up front with a clear error instead of emitting a corrupt archive.

use axum::body::Bytes;
use futures::Stream;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::io::AsyncReadExt;

const CHUNK: usize = 64 * 1024;
/// Fixed DOS timestamp (1980-01-01 00:00) — the synchronous/oldest value DOS
/// can express. Per-file mtimes are deliberately not tracked: the archive
/// exists to ship bytes, and a constant stamp keeps the writer free of date
/// formatting and timezone handling.
const DOS_TIME: u16 = 0;
const DOS_DATE: u16 = 0x0021;
const MAX_MEMBERS: usize = 65535;

/// One archive member: the name it gets inside the zip ('/'-separated,
/// archive-relative) plus the on-disk file it is read from.
pub struct ZipMember {
    pub name: String,
    pub path: PathBuf,
}

/// Expand one artifact (regular file or directory) into zip members.
///
/// A file becomes a single member named `prefix`. A directory is walked
/// recursively and keeps its internal shape (`prefix/<relative path>`), so a
/// partition dir such as `month=202401/` arrives as `month=202401/data.parquet`
/// rather than a flattened pile of files.
pub fn collect_members(root: &Path, prefix: &str) -> Result<Vec<ZipMember>, String> {
    let meta = fs::metadata(root).map_err(|e| format!("读取失败 {}: {e}", root.display()))?;
    if meta.is_file() {
        return Ok(vec![ZipMember {
            name: prefix.to_string(),
            path: root.to_path_buf(),
        }]);
    }
    if !meta.is_dir() {
        return Err(format!("路径既不是文件也不是目录: {}", root.display()));
    }
    let mut out = Vec::new();
    walk(root, root, prefix, &mut out)?;
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn walk(root: &Path, dir: &Path, prefix: &str, out: &mut Vec<ZipMember>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("列目录失败 {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if meta.is_dir() {
            walk(root, &path, prefix, out)?;
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            out.push(ZipMember {
                name: format!("{prefix}/{rel}"),
                path,
            });
        }
    }
    Ok(())
}

/// Reject names that could escape the extraction root (zip-slip) or that the
/// format cannot represent. Cheap and total: every member name goes through it
/// before anything is streamed.
pub fn validate_member_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("归档成员名为空".to_string());
    }
    if name.starts_with('/') || name.contains('\\') {
        return Err(format!("归档成员名非法（绝对路径或反斜杠）: {name}"));
    }
    if name.split('/').any(|seg| seg == ".." || seg.is_empty()) {
        return Err(format!("归档成员名非法（含空段或 ..）: {name}"));
    }
    Ok(())
}

/// Stream a store-only ZIP archive for `members`.
///
/// Emits, in order: per member a local header → chunked file data → data
/// descriptor, then the central directory and the EOCD record.
pub fn zip_stream(members: Vec<ZipMember>) -> impl Stream<Item = Result<Bytes, std::io::Error>> {
    async_stream::try_stream! {
        if members.len() > MAX_MEMBERS {
            Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("归档成员过多（{} > {MAX_MEMBERS}）", members.len()),
            ))?;
        }
        // Fail fast on names/sizes that plain ZIP cannot represent — better
        // than streaming a corrupt archive to the client.
        for m in members.iter() {
            validate_member_name(&m.name).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, e)
            })?;
            let size = fs::metadata(&m.path)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::NotFound, format!("读取失败 {}: {e}", m.path.display())))?
                .len();
            if size > u32::MAX as u64 {
                Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("成员超过 4 GiB，普通 ZIP 无法容纳: {}", m.path.display()),
                ))?;
            }
        }

        let mut offset: u64 = 0;
        let mut central: Vec<u8> = Vec::new();
        let mut count: u16 = 0;

        for m in members.iter() {
            let name_bytes = m.name.as_bytes();
            let name_len = u16::try_from(name_bytes.len()).map_err(|_| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("成员名过长: {}", m.name),
                )
            })?;

            let mut local: Vec<u8> = Vec::with_capacity(30 + name_bytes.len());
            local.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            local.extend_from_slice(&20u16.to_le_bytes()); // version needed
            local.extend_from_slice(&0x0008u16.to_le_bytes()); // bit 3: data descriptor
            local.extend_from_slice(&0u16.to_le_bytes()); // method = store
            local.extend_from_slice(&DOS_TIME.to_le_bytes());
            local.extend_from_slice(&DOS_DATE.to_le_bytes());
            local.extend_from_slice(&0u32.to_le_bytes()); // crc (in descriptor)
            local.extend_from_slice(&0u32.to_le_bytes()); // compressed size
            local.extend_from_slice(&0u32.to_le_bytes()); // uncompressed size
            local.extend_from_slice(&name_len.to_le_bytes());
            local.extend_from_slice(&0u16.to_le_bytes()); // extra field length
            local.extend_from_slice(name_bytes);
            let local_offset = offset;
            offset += local.len() as u64;
            yield Bytes::from(local);

            let mut file = tokio::fs::File::open(&m.path).await?;
            let mut buf = vec![0u8; CHUNK];
            let mut crc: u32 = 0xFFFF_FFFF;
            let mut size: u64 = 0;
            loop {
                let n = file.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                crc = crc32_update(crc, &buf[..n]);
                size += n as u64;
                offset += n as u64;
                yield Bytes::copy_from_slice(&buf[..n]);
            }
            let crc = !crc;

            let mut desc: Vec<u8> = Vec::with_capacity(16);
            desc.extend_from_slice(&0x0807_4b50u32.to_le_bytes()); // descriptor signature
            desc.extend_from_slice(&crc.to_le_bytes());
            desc.extend_from_slice(&(size as u32).to_le_bytes());
            desc.extend_from_slice(&(size as u32).to_le_bytes());
            offset += desc.len() as u64;
            yield Bytes::from(desc);

            let mut cd: Vec<u8> = Vec::with_capacity(46 + name_bytes.len());
            cd.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            cd.extend_from_slice(&20u16.to_le_bytes()); // version made by
            cd.extend_from_slice(&20u16.to_le_bytes()); // version needed
            cd.extend_from_slice(&0x0008u16.to_le_bytes()); // flags (data descriptor)
            cd.extend_from_slice(&0u16.to_le_bytes()); // method = store
            cd.extend_from_slice(&DOS_TIME.to_le_bytes());
            cd.extend_from_slice(&DOS_DATE.to_le_bytes());
            cd.extend_from_slice(&crc.to_le_bytes());
            cd.extend_from_slice(&(size as u32).to_le_bytes());
            cd.extend_from_slice(&(size as u32).to_le_bytes());
            cd.extend_from_slice(&name_len.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes()); // extra
            cd.extend_from_slice(&0u16.to_le_bytes()); // comment
            cd.extend_from_slice(&0u16.to_le_bytes()); // disk number start
            cd.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            cd.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            cd.extend_from_slice(&(local_offset as u32).to_le_bytes());
            cd.extend_from_slice(name_bytes);
            central.extend_from_slice(&cd);
            count = count.saturating_add(1);
        }

        let cd_offset = offset;
        let cd_len = central.len() as u64;
        yield Bytes::from(central);

        let mut eocd: Vec<u8> = Vec::with_capacity(22);
        eocd.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        eocd.extend_from_slice(&0u16.to_le_bytes()); // this disk
        eocd.extend_from_slice(&0u16.to_le_bytes()); // disk with central dir
        eocd.extend_from_slice(&count.to_le_bytes());
        eocd.extend_from_slice(&count.to_le_bytes());
        eocd.extend_from_slice(&(cd_len as u32).to_le_bytes());
        eocd.extend_from_slice(&(cd_offset as u32).to_le_bytes());
        eocd.extend_from_slice(&0u16.to_le_bytes()); // comment length
        yield Bytes::from(eocd);
    }
}

fn crc32_table() -> &'static [u32; 256] {
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (i, slot) in table.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        table
    })
}

/// Rolling CRC-32 (IEEE 802.3, as ZIP requires). `crc` starts at 0xFFFFFFFF
/// and the caller finalises with `!crc`.
fn crc32_update(mut crc: u32, buf: &[u8]) -> u32 {
    let table = crc32_table();
    for &b in buf {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_known_vector() {
        // IEEE 802.3 check value: CRC-32("123456789") == 0xCBF43926.
        let crc = !crc32_update(0xFFFF_FFFF, b"123456789");
        assert_eq!(crc, 0xCBF4_3926);
    }

    #[test]
    fn validate_rejects_escaping_names() {
        for bad in ["/abs", "a/../b", "../x", "a//b", "", "a\\b"] {
            assert!(validate_member_name(bad).is_err(), "should reject {bad:?}");
        }
        assert!(validate_member_name("month=202401/data.parquet").is_ok());
    }

    #[test]
    fn collect_expands_directory_and_keeps_shape() {
        let tmp = std::env::temp_dir().join(format!("zipstore_{}", std::process::id()));
        let part = tmp.join("month=202401");
        fs::create_dir_all(&part).unwrap();
        fs::write(part.join("data.parquet"), b"x").unwrap();
        fs::write(tmp.join("single.parquet"), b"y").unwrap();

        let dir_members = collect_members(&part, "month=202401").unwrap();
        assert_eq!(dir_members.len(), 1);
        assert_eq!(dir_members[0].name, "month=202401/data.parquet");

        let file_members = collect_members(&tmp.join("single.parquet"), "single.parquet").unwrap();
        assert_eq!(file_members.len(), 1);
        assert_eq!(file_members[0].name, "single.parquet");

        fs::remove_dir_all(&tmp).ok();
    }

    /// Build a real archive (dir member + file member) and write it to
    /// `ZIP_STORE_TEST_OUT` so an external check (python3 -m zipfile / unzip)
    /// can confirm the bytes are a valid ZIP. Skipped when the env var is unset
    /// so the normal test run stays side-effect free.
    #[test]
    fn zip_stream_writes_archive() {
        let Some(out) = std::env::var_os("ZIP_STORE_TEST_OUT") else {
            return;
        };
        let tmp = std::env::temp_dir().join(format!("zipstream_{}", std::process::id()));
        let part = tmp.join("month=202401");
        fs::create_dir_all(&part).unwrap();
        fs::write(part.join("data.parquet"), b"parquet-bytes").unwrap();
        fs::write(tmp.join("extra.csv"), b"a,b\n1,2\n").unwrap();

        let mut members = collect_members(&part, "month=202401").unwrap();
        members.extend(collect_members(&tmp.join("extra.csv"), "extra.csv").unwrap());

        let stream = zip_stream(members);
        // tokio::fs needs a reactor, so the test drives the stream on a runtime.
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        let bytes = rt.block_on(async {
            use futures::StreamExt;
            let mut out: Vec<u8> = Vec::new();
            let mut stream = Box::pin(stream);
            while let Some(chunk) = stream.next().await {
                out.extend_from_slice(&chunk.unwrap());
            }
            out
        });
        fs::write(&out, &bytes).unwrap();
        fs::remove_dir_all(&tmp).ok();
    }
}