//! 后端进程宿主：唯一职责是持有 Windows Job Object 并监管一个子进程树。
//!
//! 该程序不承载任何媒体业务，不接触数据库，也不提供第二套 API。
//! 契约（与 A/ADR-14、B 9.2 节对齐）：
//!
//! - 创建 KILL_ON_JOB_CLOSE 作业对象；子进程加入失败即终止子进程并以非零码退出。
//! - 把子进程 PID 写入 --pid-file，父进程据此确认接管成功。
//! - 父进程通过 stdin 管道保持存活信号；管道断开（父进程消失或主动关闭）时，
//!   立即终止子进程树并退出，不依赖父进程的 JS 退出回调。
//! - 子进程自然退出时同步退出；本进程退出即关闭作业句柄，连带回收其后代。

#[cfg(windows)]
mod platform {
    use std::fs;
    use std::io::{Read, Write};
    use std::os::windows::io::AsRawHandle;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    const EXIT_USAGE: i32 = 2;
    const EXIT_ASSIGN_FAILED: i32 = 3;
    const EXIT_SPAWN_FAILED: i32 = 4;

    pub struct Args {
        pid_file: String,
        log_file: Option<String>,
        cwd: Option<String>,
        program: String,
        program_args: Vec<String>,
    }

    fn parse_args(raw: Vec<String>) -> Result<Args, String> {
        let mut pid_file = None;
        let mut log_file = None;
        let mut cwd = None;
        let mut index = 0;
        let mut program_and_args: Vec<String> = Vec::new();
        while index < raw.len() {
            let item = raw[index].as_str();
            match item {
                "--" => {
                    program_and_args.extend(raw[index + 1..].iter().cloned());
                    break;
                }
                "--pid-file" => {
                    index += 1;
                    pid_file = raw.get(index).cloned();
                }
                "--log" => {
                    index += 1;
                    log_file = raw.get(index).cloned();
                }
                "--cwd" => {
                    index += 1;
                    cwd = raw.get(index).cloned();
                }
                other => return Err(format!("未知参数：{other}")),
            }
            index += 1;
        }
        let mut program_and_args = program_and_args.into_iter();
        let program = program_and_args
            .next()
            .ok_or_else(|| "缺少要托管的程序".to_string())?;
        Ok(Args {
            pid_file: pid_file.ok_or_else(|| "缺少 --pid-file".to_string())?,
            log_file,
            cwd,
            program,
            program_args: program_and_args.collect(),
        })
    }

    /// 创建 kill-on-close 作业对象并返回句柄。
    unsafe fn create_job() -> Result<HANDLE, String> {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(format!(
                "无法创建进程保护作业：{}",
                std::io::Error::last_os_error()
            ));
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            CloseHandle(job);
            return Err(format!("无法配置进程保护作业：{error}"));
        }
        Ok(job)
    }

    fn spawn_child(args: &Args) -> Result<Child, String> {
        let mut command = Command::new(&args.program);
        command.args(&args.program_args);
        if let Some(cwd) = &args.cwd {
            command.current_dir(cwd);
        }
        command.stdin(Stdio::null()).stdout(Stdio::null());
        match &args.log_file {
            Some(path) => {
                let file = fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(path)
                    .map_err(|error| format!("无法打开诊断日志：{error}"))?;
                command.stderr(Stdio::from(file));
            }
            None => {
                command.stderr(Stdio::null());
            }
        }
        command
            .spawn()
            .map_err(|error| format!("无法启动被托管进程：{error}"))
    }

    pub fn run() -> i32 {
        let raw: Vec<String> = std::env::args().skip(1).collect();
        let args = match parse_args(raw) {
            Ok(args) => args,
            Err(message) => {
                eprintln!("{}", message);
                return EXIT_USAGE;
            }
        };

        let job = match unsafe { create_job() } {
            Ok(job) => job,
            Err(message) => {
                eprintln!("{}", message);
                return EXIT_ASSIGN_FAILED;
            }
        };

        let mut child = match spawn_child(&args) {
            Ok(child) => child,
            Err(message) => {
                eprintln!("{}", message);
                unsafe { CloseHandle(job) };
                return EXIT_SPAWN_FAILED;
            }
        };

        let assigned =
            unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) };
        if assigned == 0 {
            let error = std::io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            unsafe { CloseHandle(job) };
            eprintln!("无法把被托管进程加入进程保护作业：{error}");
            return EXIT_ASSIGN_FAILED;
        }

        if let Err(error) = write_pid_file(&args.pid_file, child.id()) {
            let _ = child.kill();
            let _ = child.wait();
            unsafe { CloseHandle(job) };
            eprintln!("{}", error);
            return EXIT_ASSIGN_FAILED;
        }

        // 父进程存活信号：stdin 读到 EOF 即代表父进程已消失或已主动断开。
        let parent_gone = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&parent_gone);
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin();
            let mut buffer = [0_u8; 64];
            loop {
                match stdin.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
            flag.store(true, Ordering::SeqCst);
        });

        let exit_code = loop {
            if parent_gone.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                break 0;
            }
            match child.try_wait() {
                Ok(Some(status)) => break status.code().unwrap_or(0),
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => break 0,
            }
        };

        unsafe { CloseHandle(job) };
        exit_code
    }

    fn write_pid_file(path: &str, pid: u32) -> Result<(), String> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            fs::create_dir_all(parent).map_err(|error| format!("无法创建 PID 目录：{error}"))?;
        }
        let mut file =
            fs::File::create(path).map_err(|error| format!("无法写入 PID 文件：{error}"))?;
        file.write_all(pid.to_string().as_bytes())
            .map_err(|error| format!("无法写入 PID 文件：{error}"))?;
        Ok(())
    }
}

#[cfg(windows)]
fn main() {
    std::process::exit(platform::run());
}

#[cfg(not(windows))]
fn main() {
    eprintln!("后端进程宿主当前只支持 Windows");
    std::process::exit(2);
}
