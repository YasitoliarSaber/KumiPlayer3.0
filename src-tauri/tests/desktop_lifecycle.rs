#[path = "../src/desktop_lifecycle.rs"]
mod desktop_lifecycle;
#[path = "../src/window_preferences.rs"]
mod window_preferences;

use desktop_lifecycle::{Activation, DesktopLifecycle, ShutdownCompletion};
use window_preferences::{WindowPreferences, WindowPreferencesStore};

#[test]
fn repeated_launch_focuses_the_running_window() {
    let mut lifecycle = DesktopLifecycle::default();
    assert_eq!(lifecycle.activate(), Activation::Show);
}

#[test]
fn shutdown_is_started_once_and_reopen_waits_for_cleanup() {
    let mut lifecycle = DesktopLifecycle::default();
    assert!(lifecycle.begin_shutdown());
    assert!(!lifecycle.begin_shutdown());
    assert_eq!(lifecycle.activate(), Activation::Wait);
    assert_eq!(lifecycle.activate(), Activation::Wait);
    assert_eq!(lifecycle.finish_shutdown(), ShutdownCompletion::Reopen);
    assert_eq!(lifecycle.activate(), Activation::Show);
    assert!(lifecycle.begin_shutdown());
}

#[test]
fn launch_just_before_exit_is_not_lost() {
    let mut lifecycle = DesktopLifecycle::default();
    assert!(lifecycle.begin_shutdown());
    assert_eq!(lifecycle.finish_shutdown(), ShutdownCompletion::Exit);
    assert_eq!(lifecycle.activate(), Activation::Wait);
    assert!(!lifecycle.allow_exit());
    assert_eq!(lifecycle.finish_shutdown(), ShutdownCompletion::Reopen);
}

#[test]
fn ordinary_close_exits_only_after_cleanup() {
    let mut lifecycle = DesktopLifecycle::default();
    assert!(!lifecycle.allow_exit());
    assert!(lifecycle.begin_shutdown());
    assert!(!lifecycle.allow_exit());
    assert_eq!(lifecycle.finish_shutdown(), ShutdownCompletion::Exit);
    assert!(lifecycle.allow_exit());
}

#[test]
fn closing_invalidates_in_flight_startup_even_after_reopen() {
    let mut lifecycle = DesktopLifecycle::default();
    let generation = lifecycle.generation();
    assert!(lifecycle.is_current_running(generation));
    assert!(!lifecycle.cleanup_finished());
    lifecycle.begin_shutdown();
    assert!(!lifecycle.is_current_running(generation));
    assert!(!lifecycle.cleanup_finished());
    assert_eq!(lifecycle.finish_shutdown(), ShutdownCompletion::Exit);
    assert!(lifecycle.cleanup_finished());
    lifecycle.activate();
    lifecycle.finish_shutdown();
    assert!(!lifecycle.is_current_running(generation));
    assert!(lifecycle.is_current_running(lifecycle.generation()));
}

fn temporary_dir() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "kumiplayer-window-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn tray_preferences_default_to_existing_window_behavior_and_persist_independently() {
    let root = temporary_dir();
    let path = root.join("window.json");
    let store = WindowPreferencesStore::load(path.clone()).unwrap();
    assert_eq!(store.get().unwrap(), WindowPreferences::default());
    let expected = WindowPreferences {
        minimize_to_tray: true,
        close_to_tray: false,
    };
    store.save(expected).unwrap();
    assert_eq!(
        WindowPreferencesStore::load(path).unwrap().get().unwrap(),
        expected
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_preference_save_does_not_change_live_close_behavior() {
    let root = temporary_dir();
    std::fs::write(&root, b"a file cannot be a directory").unwrap();
    let store = WindowPreferencesStore::load(root.join("window.json")).unwrap();
    assert!(store
        .save(WindowPreferences {
            minimize_to_tray: false,
            close_to_tray: true,
        })
        .is_err());
    assert_eq!(store.get().unwrap(), WindowPreferences::default());
    std::fs::remove_file(root).unwrap();
}

#[test]
fn malformed_preferences_are_reported_without_overwriting_them() {
    let root = temporary_dir();
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("window.json");
    std::fs::write(&path, b"broken").unwrap();
    assert!(WindowPreferencesStore::load(path.clone()).is_err());
    assert_eq!(std::fs::read(path).unwrap(), b"broken");
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_slow_disk_save_does_not_block_window_event_reads() {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    let store =
        Arc::new(WindowPreferencesStore::load(temporary_dir().join("window.json")).unwrap());
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let writer_store = store.clone();
    let writer = std::thread::spawn(move || {
        writer_store.save_with(
            WindowPreferences {
                close_to_tray: true,
                ..WindowPreferences::default()
            },
            || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            },
        )
    });
    started_rx.recv().unwrap();
    let (read_tx, read_rx) = mpsc::channel();
    let reader_store = store.clone();
    let reader = std::thread::spawn(move || read_tx.send(reader_store.get()).unwrap());
    let while_saving = read_rx.recv_timeout(Duration::from_millis(500));
    release_tx.send(()).unwrap();
    writer.join().unwrap().unwrap();
    reader.join().unwrap();
    assert_eq!(while_saving.unwrap().unwrap(), WindowPreferences::default());
    assert!(store.get().unwrap().close_to_tray);
}
