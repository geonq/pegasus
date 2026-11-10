//! `pegasus-host --detach <args>`: start the real host with `<args>` fully detached, then exit 0.
//!
//! Launchers (Node, Electron) create children with handle inheritance on, so a host started by them
//! directly would hold the launcher's own stdout/stderr pipes for its whole life, and whatever waits
//! on those pipes (a test runner, a shell pipeline) would hang. This short-lived step holds them for
//! milliseconds only: the real host starts with no inherited handles, no console and its own process
//! group, so it outlives the app and never pins anyone's pipes.

#[cfg(windows)]
pub fn launch(args: &[String]) -> std::io::Result<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT,
        DETACHED_PROCESS, PROCESS_INFORMATION, STARTUPINFOW,
    };

    let exe = std::env::current_exe()?;
    let mut line = quote(&exe.to_string_lossy());
    for a in args {
        line.push(' ');
        line.push_str(&quote(a));
    }
    let mut wide: Vec<u16> = std::ffi::OsStr::new(&line).encode_wide().chain(Some(0)).collect();
    let app: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: zeroed STARTUPINFOW/PROCESS_INFORMATION are valid initial values; every pointer passed
    // is a live NUL-terminated buffer or null; the returned handles are closed below.
    unsafe {
        let mut si: STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessW(
            app.as_ptr(),
            wide.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0, // bInheritHandles = FALSE: the whole point
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            std::ptr::null(),
            std::ptr::null(),
            &si,
            &mut pi,
        );
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        Ok(pi.dwProcessId)
    }
}

/// CommandLineToArgvW quoting: wrap in quotes, double backslashes before a quote, escape quotes.
#[cfg(windows)]
fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in arg.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
                out.push('"');
                slashes = 0;
                continue;
            }
            _ => {}
        }
        if c != '\\' {
            out.extend(std::iter::repeat_n('\\', slashes));
            slashes = 0;
            out.push(c);
        }
    }
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
    out
}

#[cfg(unix)]
pub fn launch(args: &[String]) -> std::io::Result<u32> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    // Rust opens fds close-on-exec and stdio is /dev/null; a new session detaches from the
    // launcher's terminal and process group.
    let child = Command::new(std::env::current_exe()?)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()?;
    Ok(child.id())
}

#[cfg(all(test, windows))]
mod tests {
    use super::quote;
    #[test]
    fn quotes_like_command_line_to_argv() {
        assert_eq!(quote("plain"), "plain");
        assert_eq!(quote(r"C:\Program Files\x"), r#""C:\Program Files\x""#);
        assert_eq!(quote(r"\\.\pipe\a b"), r#""\\.\pipe\a b""#);
        assert_eq!(quote(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote(r"ends\ "), r#""ends\ ""#);
        assert_eq!(quote(r"trail\"), r"trail\");
        assert_eq!(quote(r"sp trail\"), r#""sp trail\\""#);
        assert_eq!(quote(""), r#""""#);
    }
}
