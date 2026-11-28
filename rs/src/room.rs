//! Whether the JavaScript would get all of an answer out.
//!
//! bun does not always wait for a pipe to take what the program writes:
//! what there is no room for when the program ends is lost. Measured with a
//! reader that starts a second late (the `room: …` cases of rs/parity.json
//! hold these):
//!
//! - Linux, bun 1.4.0: every write. Once yargs has looked at
//!   process.stdout, `console.log`, `console.error` and
//!   `process.stderr.write` all go out without waiting: `winrpc lock |
//!   wc -c` gets 65,536 bytes of a 100,000-byte answer, and into a pipe
//!   that already holds 64 KiB nothing at all, not even a refusal or a
//!   help page.
//! - macOS (bun 1.4.4) and Windows (bun 1.4.2): `process.stderr.write`
//!   followed by `process.exit`, which is how the lease-held line of a 423
//!   is written: 65,536 bytes of 100,000 on macOS, none on Windows.
//!   `console.log` and `console.error` wait for the reader there (100,000
//!   of 100,000, and all of it after a full pipe).
//!
//! Into a regular file nothing is lost, nor into a terminal (Linux and
//! macOS, also with a reader that is late) or /dev/null.
//!
//! So an answer is printed here only where every write that bun would not
//! wait for certainly fits: into a regular file (on Windows a file on a
//! disk, as GetFileType says); on Linux and macOS a
//! terminal or /dev/null; on Linux a pipe or a Unix stream socket with room
//! for it now (as dotenvdotenc's port works it out, its rs/src/out.rs).
//! Anything else is handed back, which for `lock show` is after its GET:
//! the JavaScript then asks the server again.

/// Which of the program's two output streams.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    Out,
    Err,
}

/// How the TypeScript writes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// `console.log` or `console.error`.
    Console,
    /// `process.stderr.write`, with `process.exit` right after it.
    Raw,
}

/// One write of the TypeScript, in the order it makes them.
#[derive(Debug)]
pub struct Write {
    pub stream: Stream,
    pub kind: Kind,
    pub bytes: Vec<u8>,
}

/// Whether bun waits for the reader, for a write of this kind, on this
/// system.
fn waits(kind: Kind) -> bool {
    !cfg!(target_os = "linux") && kind == Kind::Console
}

/// `true` when bun would get every one of these writes out whole.
pub fn certain(writes: &[Write]) -> bool {
    let shared = os::shared();
    writes.iter().enumerate().all(|(at, write)| {
        if write.bytes.is_empty() || waits(write.kind) {
            return true;
        }
        // What this process writes there first takes room as well.
        let before: Vec<usize> = writes[..at].iter().filter(|other| other.stream == write.stream || shared).map(|other| other.bytes.len()).collect();
        os::room(write.stream, before.iter().sum(), before.len()).is_some_and(|room| write.bytes.len() <= room)
    })
}

#[cfg(unix)]
mod os {
    use std::fs::{File, Metadata};
    use std::io::IsTerminal;
    use std::os::fd::{AsFd, AsRawFd};
    use std::os::unix::fs::{FileTypeExt, MetadataExt};

    use super::Stream;

    fn stat(stream: Stream) -> Option<Metadata> {
        let owned = match stream {
            Stream::Out => std::io::stdout().as_fd().try_clone_to_owned(),
            Stream::Err => std::io::stderr().as_fd().try_clone_to_owned(),
        };
        File::from(owned.ok()?).metadata().ok()
    }

    fn terminal(stream: Stream) -> bool {
        match stream {
            Stream::Out => std::io::stdout().is_terminal(),
            Stream::Err => std::io::stderr().is_terminal(),
        }
    }

    fn fd(stream: Stream) -> i32 {
        match stream {
            Stream::Out => std::io::stdout().as_raw_fd(),
            Stream::Err => std::io::stderr().as_raw_fd(),
        }
    }

    /// Are standard output and standard error the same file or pipe
    /// (`2>&1`)? Taken to be when that is not known.
    pub fn shared() -> bool {
        match (stat(Stream::Out), stat(Stream::Err)) {
            (Some(out), Some(err)) => out.dev() == err.dev() && out.ino() == err.ino(),
            _ => true,
        }
    }

    /// The room for one more write on the stream, after `before` bytes in
    /// `writes` writes of this process there: `None` where no room is
    /// certain, `Some(usize::MAX)` where a write is never cut short.
    pub fn room(stream: Stream, before: usize, writes: usize) -> Option<usize> {
        let meta = stat(stream)?;
        let kind = meta.file_type();
        if kind.is_file() {
            return Some(usize::MAX);
        }
        if kind.is_char_device() {
            let dev_null = std::fs::metadata("/dev/null").is_ok_and(|null| null.file_type().is_char_device() && null.rdev() == meta.rdev());
            return (terminal(stream) || dev_null).then_some(usize::MAX);
        }
        if kind.is_fifo() {
            return pipe(fd(stream), before, writes);
        }
        if kind.is_socket() {
            return socket(fd(stream), before, writes);
        }
        None
    }

    /// A pipe holds a number of pages; a write that does not fill a page
    /// may be added to the last one, and the first may be partly read. So
    /// what is certainly free: every page but those the bytes waiting in it
    /// can take up, one more for a page partly read, and one for each write
    /// of this process that may have left a page partly filled.
    #[cfg(target_os = "linux")]
    fn pipe(fd: i32, before: usize, writes: usize) -> Option<usize> {
        // SAFETY: plain queries of the descriptor, into locals.
        let capacity = unsafe { libc::fcntl(fd, libc::F_GETPIPE_SZ) };
        let mut waiting: libc::c_int = 0;
        let asked = unsafe { libc::ioctl(fd, libc::FIONREAD, &mut waiting) };
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if capacity <= 0 || asked != 0 || waiting < 0 || page <= 0 {
            return None;
        }
        let (capacity, page) = (capacity as usize, page as usize);
        Some(pipe_room(capacity, page, waiting as usize, before, writes))
    }

    /// A Unix stream socket takes a write whole while what it holds is below
    /// its send buffer, and counts a write of this size as its bytes and
    /// well under 4 KiB more. So one with nothing waiting in it takes up to
    /// 32 KiB, in one write or several, as long as that, with 4 KiB for each
    /// write, is well below its send buffer (dotenvdotenc's port measured
    /// one write; error answers here are two). Anything else is not
    /// certain.
    #[cfg(target_os = "linux")]
    fn socket(fd: i32, before: usize, writes: usize) -> Option<usize> {
        let option = |name: libc::c_int| -> Option<libc::c_int> {
            let mut value: libc::c_int = 0;
            let mut size = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
            // SAFETY: getsockopt writes at most `size` bytes into `value`.
            let done = unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, name, (&mut value as *mut libc::c_int).cast(), &mut size) };
            (done == 0).then_some(value)
        };
        if option(libc::SO_DOMAIN)? != libc::AF_UNIX || option(libc::SO_TYPE)? != libc::SOCK_STREAM {
            return None;
        }
        // Asked before this process writes anything: nothing may be waiting.
        let mut unsent: libc::c_int = 0;
        // SAFETY: SIOCOUTQ (TIOCOUTQ) writes one int.
        if unsafe { libc::ioctl(fd, libc::TIOCOUTQ, &mut unsent) } != 0 || unsent != 0 {
            return None;
        }
        let sndbuf = usize::try_from(option(libc::SO_SNDBUF)?).ok()?;
        Some(socket_room(sndbuf, before, writes))
    }

    /// macOS does not say how much room a pipe or a socket has.
    #[cfg(not(target_os = "linux"))]
    fn pipe(_fd: i32, _before: usize, _writes: usize) -> Option<usize> {
        None
    }

    #[cfg(not(target_os = "linux"))]
    fn socket(_fd: i32, _before: usize, _writes: usize) -> Option<usize> {
        None
    }

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn socket_room(sndbuf: usize, before: usize, writes: usize) -> usize {
        (sndbuf / 2).saturating_sub(4096).min(32768).saturating_sub(before + 4096 * writes)
    }

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn pipe_room(capacity: usize, page: usize, waiting: usize, before: usize, writes: usize) -> usize {
        let queued = waiting + before;
        let used = if queued == 0 { 0 } else { queued.div_ceil(page) + 1 + writes };
        (capacity / page).saturating_sub(used) * page
    }
}

#[cfg(windows)]
mod os {
    use std::os::windows::io::AsRawHandle;

    use super::Stream;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileType(file: *mut core::ffi::c_void) -> u32;
    }
    const FILE_TYPE_DISK: u32 = 1;

    /// Not known here; taken to be.
    pub fn shared() -> bool {
        true
    }

    /// Only a file on a disk is certain: a console cannot be told apart from
    /// the pipe of an MSYS terminal without asking Windows more, and a
    /// pipe's room is not known. (Rust's `metadata().is_file()` says yes
    /// for a pipe too: it only means "not a directory or a link" there.)
    pub fn room(stream: Stream, _before: usize, _writes: usize) -> Option<usize> {
        let handle = match stream {
            Stream::Out => std::io::stdout().as_raw_handle(),
            Stream::Err => std::io::stderr().as_raw_handle(),
        };
        // SAFETY: GetFileType only looks at the handle, which stays open.
        let disk = !handle.is_null() && unsafe { GetFileType(handle) } == FILE_TYPE_DISK;
        disk.then_some(usize::MAX)
    }
}

#[cfg(not(any(unix, windows)))]
mod os {
    use super::Stream;

    pub fn shared() -> bool {
        true
    }

    pub fn room(_stream: Stream, _before: usize, _writes: usize) -> Option<usize> {
        None
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::os::{pipe_room, socket_room};

    #[test]
    fn room_in_a_socket() {
        // Linux's default send buffer, 212,992 bytes: 32 KiB.
        assert_eq!(socket_room(212_992, 0, 0), 32768);
        // The second write of an error answer, after 23 bytes.
        assert_eq!(socket_room(212_992, 23, 1), 32768 - 23 - 4096);
        // A small send buffer.
        assert_eq!(socket_room(16384, 0, 0), 4096);
        assert_eq!(socket_room(8192, 0, 0), 0);
    }

    #[test]
    fn room_in_a_pipe() {
        // An empty pipe of 16 pages takes 64 KiB in one write.
        assert_eq!(pipe_room(65536, 4096, 0, 0, 0), 65536);
        // A byte waiting may hold a page, and a page may be partly read.
        assert_eq!(pipe_room(65536, 4096, 1, 0, 0), 65536 - 2 * 4096);
        // A second write of this process, after a first of 23 bytes.
        assert_eq!(pipe_room(65536, 4096, 0, 23, 1), 65536 - 3 * 4096);
        // A full pipe takes nothing.
        assert_eq!(pipe_room(65536, 4096, 65536, 0, 0), 0);
        assert_eq!(pipe_room(65536, 4096, 61441, 0, 0), 0);
        // A pipe made smaller.
        assert_eq!(pipe_room(8192, 4096, 0, 0, 0), 8192);
    }
}
