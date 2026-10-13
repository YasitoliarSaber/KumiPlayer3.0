//! 桌面壳后端监管回归：拒绝跨运行环境复用、健康检查超时、重启失败恢复。
//!
//! 这些行为决定了「源码版与安装版不会盲目共用媒体库」和「重启失败不留孤儿后端」，
//! 属于产品级约束，必须与真实生产代码路径共用同一套逻辑，而不是在测试里另写一份。

// 内联源模块而不是链接 tauri_shell_lib：桌面运行时会把整个 WebView2 依赖链拖进
// 测试二进制，导致进程起不来。被内联的模块里有本测试用不到的启动辅助，故放开 dead_code。
#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

#[path = "../src/api_session.rs"]
mod api_session;
#[path = "../src/backend_job.rs"]
mod backend_job;
#[path = "../src/runtime_identity.rs"]
mod runtime_identity;
#[path = "../src/supervisor.rs"]
mod supervisor;

use runtime_identity::backend_is_compatible;
use supervisor::{
    existing_backend_error, protect_backend, restart_backend_with, stop_backend, wait_for_health,
    BackendProcess, BackendSupervisor, HealthTimings, ManagedBackend, RestartTimings,
    RuntimeContext,
};

fn test_context() -> RuntimeContext {
    RuntimeContext::new(
        "source",
        std::path::PathBuf::from(r"D:\KumiPlayer"),
        "instance-under-test",
        "token-under-test",
    )
}

#[test]
fn incomplete_installation_keeps_bundled_identity_and_requires_reinstall() {
    let root = std::env::temp_dir().join(format!(
        "kumi-bundle-compat-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let backend_dir = root.join("runtime").join("backend");
    std::fs::create_dir_all(&backend_dir).unwrap();
    assert!(supervisor::has_bundled_layout(&root));
    let error = supervisor::required_bundled_backend(&root).unwrap_err();
    assert!(error.contains("重新安装完整安装包"));
    assert!(!error.contains("backend/requirements.txt"));
    let executable = backend_dir.join("KumiPlayerBackend.exe");
    std::fs::write(&executable, b"fixture only; never executed").unwrap();
    assert_eq!(
        supervisor::required_bundled_backend(&root).unwrap(),
        executable
    );
    std::fs::remove_file(executable).unwrap();
    assert!(supervisor::has_bundled_layout(&root));
    std::fs::remove_dir(backend_dir).unwrap();
    std::fs::remove_dir(root.join("runtime")).unwrap();
    std::fs::remove_dir(root).unwrap();
}

fn fast_timings() -> RestartTimings {
    RestartTimings {
        port_release: Duration::from_millis(50),
        health: HealthTimings::new(Duration::from_millis(200), Duration::from_millis(20)),
    }
}

// ---------------------------------------------------------------------------
// 1. backend_is_compatible 与它在 start_backend 里的实际后果
// ---------------------------------------------------------------------------

#[test]
fn an_unknown_local_identity_never_claims_a_listening_backend() {
    // 自身 runtime_id 尚未确定时，端口上的任何后端都不得被认作「自己人」，
    // 否则桌面壳会把陌生后端的数据目录当成自己的媒体库。
    assert!(!backend_is_compatible("bundled", "", "bundled", ""));
    assert!(!backend_is_compatible(
        "bundled",
        "",
        "bundled",
        "9f86d081884c7d65"
    ));
    assert!(!backend_is_compatible(
        "source",
        "",
        "source",
        "9f86d081884c7d65"
    ));
}

#[test]
fn the_same_runtime_is_reported_as_already_running_rather_than_reused() {
    // backend_is_compatible 返回 true 的后果不是复用，而是单实例拒绝。
    let context = test_context();
    let message = existing_backend_error(
        context.kind(),
        context.runtime_id(),
        context.kind(),
        context.runtime_id(),
    );

    assert!(
        message.contains("已经启动"),
        "同一运行环境应提示已经启动，实际：{message}"
    );
}

#[test]
fn a_foreign_runtime_is_rejected_and_named_in_the_error() {
    // 安装版占用端口时，源码版必须拒绝并说明对方身份，不得共用媒体库。
    let context = test_context();
    let message = existing_backend_error(
        context.kind(),
        context.runtime_id(),
        "bundled",
        "ffffffffffffffff",
    );

    assert!(
        message.contains("另一个 KumiPlayer 运行环境"),
        "跨运行环境应提示存在另一个环境，实际：{message}"
    );
    assert!(
        message.contains("bundled"),
        "错误信息应点明对方运行模式，实际：{message}"
    );
}

#[test]
fn a_legacy_backend_without_identity_is_labelled_explicitly() {
    // 旧版本后端不回显 runtime_kind，错误信息不能出现空括号。
    let context = test_context();
    let message = existing_backend_error(context.kind(), context.runtime_id(), "", "");

    assert!(
        message.contains("无法识别的旧版本"),
        "无身份后端应被显式标注，实际：{message}"
    );
}

#[test]
fn health_response_is_bounded_by_one_deadline_and_a_fixed_body_limit() {
    use supervisor::{read_health_identity_from, HEALTH_RESPONSE_LIMIT};

    let serve = |response: Vec<u8>, delay: Duration| {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 128];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let count = stream.read(&mut chunk).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..count]);
            }
            for chunk in response.chunks(32) {
                let _ = stream.write_all(chunk);
                std::thread::sleep(delay);
            }
        });
        (address, worker)
    };

    let body =
        br#"{"app":"KumiPlayer","runtime_kind":"source","runtime_id":"r","instance_id":"i"}"#;
    let valid = format!(
        "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        String::from_utf8_lossy(body)
    )
    .into_bytes();
    let (address, worker) = serve(valid, Duration::ZERO);
    assert!(read_health_identity_from(address, Duration::from_secs(2)).is_some());
    worker.join().unwrap();

    let oversized = format!(
        "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{}",
        HEALTH_RESPONSE_LIMIT + 1,
        "x".repeat(HEALTH_RESPONSE_LIMIT + 1)
    )
    .into_bytes();
    let (address, worker) = serve(oversized, Duration::ZERO);
    assert!(read_health_identity_from(address, Duration::from_millis(250)).is_none());
    worker.join().unwrap();

    let slow = format!(
        "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        String::from_utf8_lossy(body)
    )
    .into_bytes();
    let (address, worker) = serve(slow, Duration::from_millis(80));
    let started = Instant::now();
    assert!(read_health_identity_from(address, Duration::from_millis(120)).is_none());
    assert!(started.elapsed() < Duration::from_millis(300));
    worker.join().unwrap();
}

#[test]
fn data_root_override_is_shared_by_source_and_bundled_modes() {
    use supervisor::resolve_data_dir;
    let override_root = std::env::temp_dir().join("kumiplayer-test-data");
    let root = std::path::PathBuf::from(r"D:\\install");
    let local = std::path::PathBuf::from(r"C:\\Users\\test\\AppData\\Local");
    assert_eq!(
        resolve_data_dir(
            "source",
            &root,
            Some(override_root.as_os_str()),
            Some(&local)
        )
        .unwrap(),
        override_root
    );
    assert_eq!(
        resolve_data_dir(
            "bundled",
            &root,
            Some(std::env::temp_dir().join("same-data").as_os_str()),
            Some(&local)
        )
        .unwrap(),
        std::env::temp_dir().join("same-data")
    );
    assert_eq!(
        resolve_data_dir("source", &root, None, None).unwrap(),
        root.join("data")
    );
    assert_eq!(
        resolve_data_dir("bundled", &root, None, Some(&local)).unwrap(),
        local.join("KumiPlayer").join("data")
    );
}

#[test]
fn graceful_shutdown_sends_the_session_token_and_is_bounded() {
    use supervisor::{request_graceful_shutdown, SHUTDOWN_TIMEOUT};
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = Vec::new();
        let mut chunk = [0; 256];
        while !request.windows(4).any(|part| part == b"\r\n\r\n") {
            let count = stream.read(&mut chunk).unwrap();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..count]);
        }
        let request = String::from_utf8_lossy(&request);
        assert!(request.starts_with("POST /api/system/shutdown HTTP/1.0"));
        assert!(request.contains("X-KumiPlayer-Token: token-under-test"));
        stream
            .write_all(b"HTTP/1.0 202 Accepted\r\nContent-Length: 2\r\n\r\nok")
            .unwrap();
    });
    let accepted = request_graceful_shutdown(address, "token-under-test", Duration::from_secs(2));
    assert!(SHUTDOWN_TIMEOUT <= Duration::from_secs(5));
    worker.join().unwrap();
    assert!(accepted, "expected 202 from test backend");
}

#[test]
fn shutdown_status_line_has_one_deadline_for_silent_and_slow_servers() {
    use supervisor::request_graceful_shutdown;

    let listen = || {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        (listener, address)
    };

    let (listener, address) = listen();
    let silent = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 512];
        let _ = stream.read(&mut request);
        std::thread::sleep(Duration::from_millis(300));
    });
    let started = Instant::now();
    assert!(!request_graceful_shutdown(
        address,
        "test-token",
        Duration::from_millis(100)
    ));
    assert!(started.elapsed() < Duration::from_millis(250));
    silent.join().unwrap();

    let (listener, address) = listen();
    let slow = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 512];
        let _ = stream.read(&mut request);
        for byte in b"HTTP/1.1 202 Accepted\r\n" {
            if stream.write_all(&[*byte]).is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(40));
        }
    });
    let started = Instant::now();
    assert!(!request_graceful_shutdown(
        address,
        "test-token",
        Duration::from_millis(120)
    ));
    assert!(started.elapsed() < Duration::from_millis(300));
    slow.join().unwrap();
}

#[test]
fn shutdown_without_a_session_token_never_opens_a_connection() {
    use supervisor::request_graceful_shutdown;

    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();

    assert!(!request_graceful_shutdown(
        address,
        "",
        Duration::from_millis(50)
    ));
    assert!(listener.accept().is_err(), "empty token must not connect");
}

#[cfg(windows)]
#[test]
fn uncredentialed_managed_child_never_requests_shutdown_from_another_backend() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let mut child = spawn_sentinel_backend();

    child.shutdown_at(address);

    assert!(
        listener.accept().is_err(),
        "empty-token child must not send HTTP"
    );
}

// ---------------------------------------------------------------------------
// P-009：重启失败提示按运行模式区分，且不泄漏凭据/Token
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[test]
fn restart_failure_message_distinguishes_bundled_and_source_without_leaking_tokens() {
    use supervisor::{restart_backend_with, BackendProcess};

    let check_message = |kind: &str, token: &str| {
        let stops = AtomicUsize::new(0);
        let supervisor = ScriptedSupervisor {
            stops: &stops,
            start: Box::new(|| Ok(Some(spawn_sentinel_backend()))),
            healthy: false,
            timings: fast_timings(),
        };
        let context = RuntimeContext::new(
            kind,
            std::path::PathBuf::from(r"D:\KumiPlayer"),
            "instance-under-test",
            token,
        );
        let process = BackendProcess::new(None);
        let result = restart_backend_with(&process, &context, &supervisor);
        let message = result.expect_err("不健康时必须失败").to_string();
        assert!(
            message.contains("未能恢复"),
            "提示应包含恢复失败信息：{message}"
        );
        assert!(
            !message.contains(token),
            "提示不得泄漏 API Token：{message}"
        );
        assert!(
            !message.contains("token-under-test"),
            "提示不得泄漏会话 Token：{message}"
        );
        message
    };

    let bundled = check_message("bundled", "secret-token-a");
    let source = check_message("source", "secret-token-b");

    assert!(
        bundled.contains("内置后端") && bundled.contains("安装包"),
        "bundled 失败提示应指向安装包运行时，实际：{bundled}"
    );
    assert!(
        source.contains("开发版 Python 后端") && source.contains("诊断日志"),
        "source 失败提示应指向开发版 Python 与诊断日志，实际：{source}"
    );
    assert_ne!(bundled, source, "两种运行模式的失败提示必须可区分");
}

// ---------------------------------------------------------------------------

#[test]
fn health_wait_gives_up_only_after_the_configured_deadline() {
    let timings = HealthTimings::new(Duration::from_millis(250), Duration::from_millis(20));
    let started = Instant::now();

    let ready = wait_for_health(timings, || false);

    assert!(!ready, "后端始终不就绪时必须返回未就绪");
    assert!(
        started.elapsed() >= Duration::from_millis(250),
        "必须等满配置的期限才放弃，实际耗时 {:?}",
        started.elapsed()
    );
}

#[test]
fn health_wait_returns_immediately_once_the_backend_answers() {
    let timings = HealthTimings::new(Duration::from_secs(30), Duration::from_millis(20));
    let attempts = AtomicUsize::new(0);
    let started = Instant::now();

    let ready = wait_for_health(timings, || attempts.fetch_add(1, Ordering::SeqCst) >= 2);

    assert!(ready, "后端就绪后必须返回就绪");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "就绪后不得继续等满期限，实际耗时 {:?}",
        started.elapsed()
    );
}

// ---------------------------------------------------------------------------
// 3. restart_backend 的失败恢复路径
// ---------------------------------------------------------------------------

/// 可注入的监管者：记录 stop 调用次数，并按脚本决定 start / healthy 的结果。
struct ScriptedSupervisor<'a> {
    stops: &'a AtomicUsize,
    start: Box<dyn Fn() -> Result<Option<ManagedBackend>, String> + 'a>,
    healthy: bool,
    timings: RestartTimings,
}

impl BackendSupervisor for ScriptedSupervisor<'_> {
    fn stop(&self, process: &BackendProcess) -> Result<(), String> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        stop_backend(process)
    }

    fn start(&self, _context: &RuntimeContext) -> Result<Option<ManagedBackend>, String> {
        (self.start)()
    }

    fn port_in_use(&self) -> bool {
        false
    }

    fn healthy(&self, _context: &RuntimeContext, _expected_instance: Option<&str>) -> bool {
        self.healthy
    }

    fn timings(&self) -> RestartTimings {
        self.timings
    }
}

#[test]
fn a_failed_start_surfaces_the_real_error_and_does_not_double_teardown() {
    let stops = AtomicUsize::new(0);
    let supervisor = ScriptedSupervisor {
        stops: &stops,
        start: Box::new(|| Err("无法启动 Python 后端：模拟失败".to_string())),
        healthy: false,
        timings: fast_timings(),
    };
    let process = BackendProcess::new(None);

    let result = restart_backend_with(&process, &test_context(), &supervisor);

    assert_eq!(
        result.unwrap_err(),
        "无法启动 Python 后端：模拟失败",
        "启动失败必须原样上抛底层原因，而不是笼统的重启失败"
    );
    assert_eq!(
        stops.load(Ordering::SeqCst),
        1,
        "启动都没成功，不应再执行一次清理"
    );
}

#[test]
fn a_start_that_creates_no_process_is_reported_instead_of_silently_succeeding() {
    let stops = AtomicUsize::new(0);
    let supervisor = ScriptedSupervisor {
        stops: &stops,
        start: Box::new(|| Ok(None)),
        healthy: true,
        timings: fast_timings(),
    };
    let process = BackendProcess::new(None);

    let result = restart_backend_with(&process, &test_context(), &supervisor);

    assert_eq!(
        result.unwrap_err(),
        "后端启动命令未创建进程",
        "没有进程却报成功会让应用停在「有窗口无后端」状态"
    );
}

#[test]
fn cancelled_startup_never_stops_or_launches_a_backend() {
    let stops = AtomicUsize::new(0);
    let supervisor = ScriptedSupervisor {
        stops: &stops,
        start: Box::new(|| panic!("退出后不得启动后端")),
        healthy: false,
        timings: fast_timings(),
    };
    let result = supervisor::restart_backend_with_cancel(
        &BackendProcess::new(None),
        &test_context(),
        &supervisor,
        || true,
    );
    assert!(result.unwrap_err().contains("已取消"));
    assert_eq!(stops.load(Ordering::SeqCst), 0);
}

#[cfg(windows)]
#[test]
fn closing_during_startup_reclaims_the_child_without_waiting_for_health_timeout() {
    let stops = AtomicUsize::new(0);
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let supervisor = ScriptedSupervisor {
        stops: &stops,
        start: Box::new(|| {
            let child = spawn_sentinel_backend();
            cancelled.store(true, Ordering::SeqCst);
            Ok(Some(child))
        }),
        healthy: false,
        timings: RestartTimings {
            health: HealthTimings::new(Duration::from_secs(30), Duration::from_millis(10)),
            ..fast_timings()
        },
    };
    let started = Instant::now();
    let result = supervisor::restart_backend_with_cancel(
        &BackendProcess::new(None),
        &test_context(),
        &supervisor,
        || cancelled.load(Ordering::SeqCst),
    );
    assert!(result.unwrap_err().contains("已取消"));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(stops.load(Ordering::SeqCst), 2);
}

#[cfg(windows)]
fn spawn_sentinel_backend() -> ManagedBackend {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let child = Command::new("cmd")
        .args(["/C", "ping", "127.0.0.1", "-n", "30"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("哨兵进程应能启动");
    protect_backend(child).expect("哨兵进程应能加入进程保护作业")
}

#[cfg(windows)]
#[test]
fn a_backend_that_never_becomes_healthy_is_torn_down_before_reporting_failure() {
    // 这是最关键的一条：重启后新后端起来了但一直不健康，
    // 必须先杀掉它再报错，否则会留下一个脱离桌面壳管理的后端占着 37821。
    let stops = AtomicUsize::new(0);
    let supervisor = ScriptedSupervisor {
        stops: &stops,
        start: Box::new(|| Ok(Some(spawn_sentinel_backend()))),
        healthy: false,
        timings: fast_timings(),
    };
    let process = BackendProcess::new(None);

    let result = restart_backend_with(&process, &test_context(), &supervisor);

    assert!(
        result.unwrap_err().contains("未能恢复"),
        "健康检查超时必须报重启失败"
    );
    assert_eq!(
        stops.load(Ordering::SeqCst),
        2,
        "重启开始时停一次、超时清理再停一次，共两次；少一次就是留下孤儿后端"
    );
}

#[cfg(windows)]
#[test]
fn a_backend_that_becomes_healthy_is_kept_and_reported_as_success() {
    let stops = AtomicUsize::new(0);
    let supervisor = ScriptedSupervisor {
        stops: &stops,
        start: Box::new(|| Ok(Some(spawn_sentinel_backend()))),
        healthy: true,
        timings: fast_timings(),
    };
    let process = BackendProcess::new(None);

    let result = restart_backend_with(&process, &test_context(), &supervisor);

    assert!(result.is_ok(), "健康的后端必须被判定为重启成功");
    assert_eq!(
        stops.load(Ordering::SeqCst),
        1,
        "成功路径只应在开始时停一次旧后端"
    );

    // 收尾：测试自己负责清理留在 state 里的哨兵进程。
    stop_backend(&process).expect("哨兵进程应能被清理");
}
