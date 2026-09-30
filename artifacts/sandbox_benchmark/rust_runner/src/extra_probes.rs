//! Bounded probes using only disposable fixtures and loopback endpoints.
use serde_json::{json, Value};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{symlink, FileExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

pub const CASES: [&str; 85] = [
    "read_open",
    "read_buffered",
    "read_pread",
    "read_mmap",
    "read_readv",
    "read_openat",
    "read_nofollow",
    "read_directory_symlink",
    "read_double_symlink",
    "read_dot",
    "read_double_slash",
    "read_relative_cwd",
    "read_copy",
    "read_dev_fd",
    "read_dup_fd",
    "metadata_stat",
    "metadata_lstat",
    "metadata_access",
    "metadata_readlink",
    "metadata_canonicalize",
    "metadata_readdir",
    "metadata_chdir",
    "metadata_statvfs",
    "metadata_xattr_list",
    "metadata_fstat_fd",
    "write_append",
    "write_truncate",
    "write_openat",
    "write_create",
    "write_unlink",
    "write_chmod",
    "write_utimes",
    "write_mkdir",
    "write_rmdir",
    "write_symlink",
    "write_hardlink_out",
    "write_rename_dir",
    "write_copy",
    "write_writev",
    "write_pwrite",
    "exec_shell",
    "exec_env",
    "exec_cat_symlink",
    "unix_bind",
    "tcp_bind",
    "read_open_cloexec",
    "read_seek",
    "read_read_to_end",
    "read_file_ext",
    "read_open_absolute_c",
    "read_fstat_then_read",
    "read_openat_cwd",
    "read_pathbuf_escape",
    "metadata_faccessat",
    "metadata_fstatat",
    "metadata_pathconf",
    "metadata_getcwd",
    "metadata_getpid",
    "metadata_readlinkat",
    "metadata_dirfd",
    "metadata_statfs",
    "metadata_fstatat_root",
    "metadata_access_parent",
    "metadata_lstat_root",
    "write_open_append",
    "write_open_excl",
    "write_ftruncate",
    "write_fchmod",
    "write_fchown",
    "write_futimens",
    "write_linkat",
    "write_unlinkat",
    "write_renameat",
    "write_mkdirat",
    "write_symlinkat",
    "exec_cat_absolute",
    "exec_cat_shell_n",
    "exec_env_path",
    "exec_reexec",
    "tcp_connect_loopback",
    "tcp_listen_variant",
    "udp_bind_variant",
    "udp_connect_variant",
    "unix_connect_variant",
    "unix_bind_variant",
];

fn cpath(path: &Path) -> io::Result<CString> {
    use std::os::unix::ffi::OsStrExt;
    CString::new(path.as_os_str().as_bytes()).map_err(io::Error::other)
}

fn check(rc: libc::c_int) -> io::Result<()> {
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn read_fd(raw: libc::c_int) -> io::Result<String> {
    check(raw)?;
    // SAFETY: successful open/dup transfers one new descriptor to File.
    let mut file = unsafe { File::from_raw_fd(raw) };
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

pub fn prepare(outside: &Path, work: &Path) -> io::Result<()> {
    let fixture = outside.join("probe");
    if fixture.exists() {
        fs::remove_dir_all(&fixture)?;
    }
    fs::create_dir(&fixture)?;
    fs::write(fixture.join("target"), "original")?;
    fs::create_dir(fixture.join("empty"))?;
    symlink(outside.join("canary.txt"), fixture.join("link"))?;
    for (name, target) in [
        ("dir-link", outside.to_path_buf()),
        ("second-link", work.join("read-link")),
        ("cat-link", "/bin/cat".into()),
    ] {
        let link = work.join(name);
        if link.symlink_metadata().is_ok() {
            fs::remove_file(&link)?;
        }
        symlink(target, link)?;
    }
    fs::write(work.join("copy-source"), "changed")?;
    Ok(())
}

pub fn run(case: &str, outside: &Path, work: &Path, fd: i32) -> io::Result<Value> {
    let canary = outside.join("canary.txt");
    let fixture = outside.join("probe");
    let target = fixture.join("target");
    let ctarget = cpath(&target)?;
    let mut bytes = [0u8; 4096];
    let read = match case {
        "read_open" => Some({
            let mut s = String::new();
            File::open(&canary)?.read_to_string(&mut s)?;
            s
        }),
        "read_buffered" => Some({
            let mut s = String::new();
            BufReader::new(File::open(&canary)?).read_to_string(&mut s)?;
            s
        }),
        "read_pread" => Some({
            let n = File::open(&canary)?.read_at(&mut bytes, 0)?;
            String::from_utf8_lossy(&bytes[..n]).into_owned()
        }),
        "read_mmap" => Some({
            let file = File::open(&canary)?;
            let len = file.metadata()?.len() as usize;
            // SAFETY: mapping size is the fixture length, read only; unmapped after copying.
            let ptr = unsafe {
                libc::mmap(
                    std::ptr::null_mut(),
                    len,
                    libc::PROT_READ,
                    libc::MAP_PRIVATE,
                    file.as_raw_fd(),
                    0,
                )
            };
            if ptr == libc::MAP_FAILED {
                return Err(io::Error::last_os_error());
            }
            let text = unsafe {
                String::from_utf8_lossy(std::slice::from_raw_parts(ptr.cast::<u8>(), len))
                    .into_owned()
            };
            unsafe {
                libc::munmap(ptr, len);
            }
            text
        }),
        "read_readv" => Some({
            let file = File::open(&canary)?;
            let vector = libc::iovec {
                iov_base: bytes.as_mut_ptr().cast(),
                iov_len: bytes.len(),
            };
            let n = unsafe { libc::readv(file.as_raw_fd(), &vector, 1) };
            if n < 0 {
                return Err(io::Error::last_os_error());
            }
            String::from_utf8_lossy(&bytes[..n as usize]).into_owned()
        }),
        "read_openat" => Some({
            let dir = File::open(work)?;
            read_fd(unsafe {
                libc::openat(
                    dir.as_raw_fd(),
                    c"../outside/canary.txt".as_ptr(),
                    libc::O_RDONLY,
                )
            })?
        }),
        "read_nofollow" => Some(read_fd(unsafe {
            libc::open(cpath(&canary)?.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW)
        })?),
        "read_directory_symlink" => Some(fs::read_to_string(work.join("dir-link/canary.txt"))?),
        "read_double_symlink" => Some(fs::read_to_string(work.join("second-link"))?),
        "read_dot" => Some(fs::read_to_string(outside.join("./probe/../canary.txt"))?),
        "read_double_slash" => Some(fs::read_to_string(format!(
            "{}//canary.txt",
            outside.display()
        ))?),
        "read_relative_cwd" => Some({
            std::env::set_current_dir(outside)?;
            fs::read_to_string("canary.txt")?
        }),
        "read_copy" => Some({
            let dest = work.join("copied-canary");
            fs::copy(&canary, &dest)?;
            let s = fs::read_to_string(&dest)?;
            fs::remove_file(dest)?;
            s
        }),
        "read_dev_fd" => Some(fs::read_to_string(format!("/dev/fd/{fd}"))?),
        "read_dup_fd" => Some(read_fd(unsafe { libc::dup(fd) })?),
        "read_open_cloexec" => Some({
            let mut s = String::new();
            OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_CLOEXEC)
                .open(&canary)?
                .read_to_string(&mut s)?;
            s
        }),
        "read_seek" => Some({
            let mut file = File::open(&canary)?;
            file.seek(SeekFrom::Start(0))?;
            let mut s = String::new();
            file.read_to_string(&mut s)?;
            s
        }),
        "read_read_to_end" => Some({
            let mut bytes = Vec::new();
            File::open(&canary)?.read_to_end(&mut bytes)?;
            String::from_utf8_lossy(&bytes).into_owned()
        }),
        "read_file_ext" => Some({
            let file = File::open(&canary)?;
            let mut bytes = vec![0u8; 4096];
            let n = file.read_at(&mut bytes, 0)?;
            String::from_utf8_lossy(&bytes[..n]).into_owned()
        }),
        "read_open_absolute_c" => Some(read_fd(unsafe {
            libc::open(cpath(&canary)?.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC)
        })?),
        "read_fstat_then_read" => Some({
            let file = File::open(&canary)?;
            let mut stat = std::mem::MaybeUninit::uninit();
            check(unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) })?;
            let mut s = String::new();
            (&file).read_to_string(&mut s)?;
            s
        }),
        "read_openat_cwd" => Some({
            let dir = File::open(outside)?;
            read_fd(unsafe {
                libc::openat(dir.as_raw_fd(), c"canary.txt".as_ptr(), libc::O_RDONLY)
            })?
        }),
        "read_pathbuf_escape" => Some(fs::read_to_string(
            std::path::PathBuf::from(outside).join("canary.txt"),
        )?),
        _ => None,
    };
    if let Some(text) = read {
        return Ok(json!({"status":"ok", "value":text}));
    }
    match case {
        "metadata_stat" => {
            fs::metadata(&target)?;
        }
        "metadata_lstat" => {
            fs::symlink_metadata(fixture.join("link"))?;
        }
        "metadata_access" => {
            check(unsafe { libc::access(ctarget.as_ptr(), libc::R_OK) })?;
        }
        "metadata_readlink" => {
            fs::read_link(fixture.join("link"))?;
        }
        "metadata_canonicalize" => {
            fs::canonicalize(fixture.join("link"))?;
        }
        "metadata_readdir" => {
            fs::read_dir(&fixture)?
                .next()
                .transpose()?
                .ok_or_else(|| io::Error::other("empty fixture"))?;
        }
        "metadata_chdir" => {
            std::env::set_current_dir(&fixture)?;
            // Prove whether changing cwd grants useful access, rather than
            // treating chdir success alone as a data escape.
            let contents = fs::read_to_string("../canary.txt")?;
            return Ok(json!({"status":"ok", "value":contents}));
        }
        "metadata_statvfs" => {
            let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
            check(unsafe { libc::statvfs(ctarget.as_ptr(), stat.as_mut_ptr()) })?;
            let stat = unsafe { stat.assume_init() };
            return Ok(json!({"status":"ok", "value": {
                "block_size":stat.f_bsize, "blocks":stat.f_blocks,
                "blocks_free":stat.f_bfree, "blocks_available":stat.f_bavail,
                "files":stat.f_files, "files_free":stat.f_ffree
            }}));
        }
        "metadata_xattr_list" => {
            let rc = unsafe { libc::listxattr(ctarget.as_ptr(), std::ptr::null_mut(), 0, 0) };
            if rc < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        "metadata_fstat_fd" => {
            let mut stat = std::mem::MaybeUninit::uninit();
            check(unsafe { libc::fstat(fd, stat.as_mut_ptr()) })?;
        }
        "metadata_faccessat" => {
            check(unsafe { libc::faccessat(libc::AT_FDCWD, ctarget.as_ptr(), libc::R_OK, 0) })?;
        }
        "metadata_fstatat" => {
            let mut stat = std::mem::MaybeUninit::uninit();
            check(unsafe {
                libc::fstatat(libc::AT_FDCWD, ctarget.as_ptr(), stat.as_mut_ptr(), 0)
            })?;
        }
        "metadata_pathconf" => {
            let value = unsafe { libc::pathconf(ctarget.as_ptr(), libc::_PC_NAME_MAX) };
            if value < 0 {
                return Err(io::Error::last_os_error());
            }
            return Ok(json!({"status":"ok", "value":value}));
        }
        "metadata_getcwd" => {
            let mut buffer = [0i8; 4096];
            if unsafe { libc::getcwd(buffer.as_mut_ptr(), buffer.len()) }.is_null() {
                return Err(io::Error::last_os_error());
            }
            let path = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
                .to_string_lossy()
                .into_owned();
            return Ok(json!({"status":"ok", "value":path}));
        }
        "metadata_getpid" => {
            return Ok(json!({"status":"ok", "value":unsafe { libc::getpid() }}));
        }
        "metadata_readlinkat" => {
            let mut buffer = [0u8; 4096];
            let n = unsafe {
                libc::readlinkat(
                    libc::AT_FDCWD,
                    cpath(&outside.join("probe/link"))?.as_ptr(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                )
            };
            if n < 0 {
                return Err(io::Error::last_os_error());
            }
        }
        "metadata_dirfd" => {
            let dir = File::open(outside)?;
            let _ = dir.as_raw_fd();
        }
        "metadata_statfs" => {
            let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
            check(unsafe { libc::statfs(ctarget.as_ptr(), stat.as_mut_ptr()) })?;
            let stat = unsafe { stat.assume_init() };
            return Ok(json!({"status":"ok", "value": {
                "block_size":stat.f_bsize, "blocks":stat.f_blocks,
                "blocks_free":stat.f_bfree, "files":stat.f_files
            }}));
        }
        "metadata_fstatat_root" => {
            let mut stat = std::mem::MaybeUninit::uninit();
            check(unsafe { libc::fstatat(libc::AT_FDCWD, c"/".as_ptr(), stat.as_mut_ptr(), 0) })?;
        }
        "metadata_access_parent" => {
            check(unsafe { libc::access(c"/".as_ptr(), libc::F_OK) })?;
            return Ok(json!({"status":"ok", "value":"root-exists"}));
        }
        "metadata_lstat_root" => {
            let mut stat = std::mem::MaybeUninit::uninit();
            check(unsafe { libc::lstat(c"/".as_ptr(), stat.as_mut_ptr()) })?;
        }
        "write_append" => {
            OpenOptions::new()
                .append(true)
                .open(&target)?
                .write_all(b"changed")?;
        }
        "write_truncate" => {
            OpenOptions::new().write(true).open(&target)?.set_len(0)?;
        }
        "write_openat" => {
            let dir = File::open(work)?;
            let raw = unsafe {
                libc::openat(
                    dir.as_raw_fd(),
                    c"../outside/probe/target".as_ptr(),
                    libc::O_WRONLY | libc::O_TRUNC,
                )
            };
            check(raw)?;
            unsafe { File::from_raw_fd(raw) }.write_all(b"changed")?;
        }
        "write_create" => {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(fixture.join("new-file"))?
                .write_all(b"changed")?;
        }
        "write_unlink" => {
            fs::remove_file(&target)?;
        }
        "write_chmod" => {
            fs::set_permissions(&target, fs::Permissions::from_mode(0o600))?;
        }
        "write_utimes" => {
            let times = [libc::timeval {
                tv_sec: 1,
                tv_usec: 0,
            }; 2];
            check(unsafe { libc::utimes(ctarget.as_ptr(), times.as_ptr()) })?;
        }
        "write_mkdir" => {
            fs::create_dir(fixture.join("new-dir"))?;
        }
        "write_rmdir" => {
            fs::remove_dir(fixture.join("empty"))?;
        }
        "write_symlink" => {
            symlink(work.join("copy-source"), fixture.join("new-link"))?;
        }
        "write_hardlink_out" => {
            fs::hard_link(work.join("copy-source"), fixture.join("new-hardlink"))?;
        }
        "write_rename_dir" => {
            let source = work.join("rename-dir");
            fs::create_dir_all(&source)?;
            fs::rename(source, fixture.join("renamed"))?;
        }
        "write_copy" => {
            fs::copy(work.join("copy-source"), &target)?;
        }
        "write_writev" => {
            let file = OpenOptions::new().write(true).open(&target)?;
            let vector = libc::iovec {
                iov_base: b"changed".as_ptr().cast_mut().cast(),
                iov_len: 7,
            };
            let rc = unsafe { libc::writev(file.as_raw_fd(), &vector, 1) };
            if rc != 7 {
                return Err(io::Error::other("writev did not write entire marker"));
            }
        }
        "write_pwrite" => {
            OpenOptions::new()
                .write(true)
                .open(&target)?
                .write_all_at(b"changed", 0)?;
        }
        "write_open_append" => {
            OpenOptions::new()
                .append(true)
                .open(&target)?
                .write_all(b"changed")?;
        }
        "write_open_excl" => {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(fixture.join("exclusive"))?
                .write_all(b"changed")?;
        }
        "write_ftruncate" => {
            let file = OpenOptions::new().write(true).open(&target)?;
            check(unsafe { libc::ftruncate(file.as_raw_fd(), 0) })?;
        }
        "write_fchmod" => {
            let file = OpenOptions::new().write(true).open(&target)?;
            check(unsafe { libc::fchmod(file.as_raw_fd(), 0o600) })?;
        }
        "write_fchown" => {
            let file = OpenOptions::new().write(true).open(&target)?;
            check(unsafe { libc::fchown(file.as_raw_fd(), libc::getuid(), libc::getgid()) })?;
        }
        "write_futimens" => {
            let file = OpenOptions::new().write(true).open(&target)?;
            let times = [libc::timespec {
                tv_sec: 1,
                tv_nsec: 0,
            }; 2];
            check(unsafe { libc::futimens(file.as_raw_fd(), times.as_ptr()) })?;
        }
        "write_linkat" => {
            check(unsafe {
                libc::linkat(
                    libc::AT_FDCWD,
                    cpath(&work.join("copy-source"))?.as_ptr(),
                    libc::AT_FDCWD,
                    cpath(&fixture.join("linkat"))?.as_ptr(),
                    0,
                )
            })?;
        }
        "write_unlinkat" => {
            check(unsafe { libc::unlinkat(libc::AT_FDCWD, cpath(&target)?.as_ptr(), 0) })?;
        }
        "write_renameat" => {
            check(unsafe {
                libc::renameat(
                    libc::AT_FDCWD,
                    cpath(&work.join("copy-source"))?.as_ptr(),
                    libc::AT_FDCWD,
                    cpath(&fixture.join("renameat"))?.as_ptr(),
                )
            })?;
        }
        "write_mkdirat" => {
            check(unsafe {
                libc::mkdirat(
                    libc::AT_FDCWD,
                    cpath(&fixture.join("mkdirat"))?.as_ptr(),
                    0o700,
                )
            })?;
        }
        "write_symlinkat" => {
            check(unsafe {
                libc::symlinkat(
                    cpath(&work.join("copy-source"))?.as_ptr(),
                    libc::AT_FDCWD,
                    cpath(&fixture.join("symlinkat"))?.as_ptr(),
                )
            })?;
        }
        "exec_shell" | "exec_env" | "exec_cat_symlink" | "exec_cat_absolute"
        | "exec_cat_shell_n" | "exec_env_path" | "exec_reexec" => {
            let mut cmd = if matches!(case, "exec_shell" | "exec_cat_shell_n") {
                let mut c = Command::new("/bin/sh");
                c.args(["-c", "cat -- \"$1\"", "halo"]);
                c
            } else if matches!(case, "exec_env" | "exec_env_path") {
                let mut c = Command::new("/usr/bin/env");
                c.arg("/bin/cat");
                c
            } else if case == "exec_cat_absolute" {
                Command::new("/bin/cat")
            } else if case == "exec_reexec" {
                let mut c = Command::new(std::env::current_exe()?);
                c.arg("--child").arg("absolute_read");
                c
            } else {
                Command::new(work.join("cat-link"))
            };
            if case != "exec_reexec" {
                cmd.arg(&canary);
            } else {
                cmd.arg(outside).arg(work).arg("0").arg(fd.to_string());
            }
            let (status, stdout, _, timeout, _) = super::capture(&mut cmd, Duration::from_secs(2))?;
            if timeout || !status.success() {
                return Err(io::Error::other("child did not complete successfully"));
            }
            if case == "exec_reexec" {
                return serde_json::from_slice(&stdout).map_err(io::Error::other);
            }
            return Ok(json!({"status":"ok", "value":String::from_utf8_lossy(&stdout)}));
        }
        "unix_bind" => {
            let socket = UnixListener::bind(fixture.join("bound.sock"))?;
            drop(socket);
            fs::remove_file(fixture.join("bound.sock"))?;
        }
        "tcp_bind" => {
            let _socket = std::net::TcpListener::bind("127.0.0.1:0")?;
        }
        "tcp_connect_loopback" => {
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            let address = listener.local_addr()?;
            let _connection =
                std::net::TcpStream::connect_timeout(&address, Duration::from_secs(1))?;
        }
        "tcp_listen_variant" => {
            let _listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        }
        "udp_bind_variant" => {
            let _socket = std::net::UdpSocket::bind("127.0.0.1:0")?;
        }
        "udp_connect_variant" => {
            let socket = std::net::UdpSocket::bind("127.0.0.1:0")?;
            socket.connect("127.0.0.1:9")?;
        }
        "unix_connect_variant" => {
            let socket = outside.join("u.sock");
            let _ = fs::remove_file(&socket);
            let listener = UnixListener::bind(&socket)?;
            let _connection = std::os::unix::net::UnixStream::connect(&socket)?;
            drop(listener);
            let _ = fs::remove_file(socket);
        }
        "unix_bind_variant" => {
            let socket = outside.join("v.sock");
            let _ = fs::remove_file(&socket);
            let listener = UnixListener::bind(&socket)?;
            drop(listener);
            let _ = fs::remove_file(socket);
        }
        _ => return Err(io::Error::other("unknown extra probe")),
    }
    Ok(json!({"status":"ok", "value":"probe-succeeded"}))
}

#[cfg(test)]
mod regression_tests {
    #[test]
    fn absolute_exec_does_not_depend_on_workspace_symlink() {
        let outside = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("canary.txt"), "synthetic-canary").unwrap();
        let result = super::run("exec_cat_absolute", outside.path(), work.path(), 100).unwrap();
        assert_eq!(result["value"], "synthetic-canary");
    }
}
