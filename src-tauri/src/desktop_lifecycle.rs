//! 可测试的窗口退出状态：清理期间保留单实例入口，重开请求等清理完成后恢复。

#[derive(Debug, PartialEq, Eq)]
pub enum Activation {
    Show,
    Wait,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ShutdownCompletion {
    Reopen,
    Exit,
}

#[derive(Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Running,
    Stopping,
    ReadyToExit,
}

#[derive(Default)]
pub struct DesktopLifecycle {
    phase: Phase,
    reopen: bool,
    generation: u64,
}

impl DesktopLifecycle {
    pub fn activate(&mut self) -> Activation {
        if self.phase == Phase::Running {
            Activation::Show
        } else {
            self.reopen = true;
            Activation::Wait
        }
    }

    pub fn begin_shutdown(&mut self) -> bool {
        if self.phase != Phase::Running {
            return false;
        }
        self.phase = Phase::Stopping;
        self.generation += 1;
        true
    }

    pub fn finish_shutdown(&mut self) -> ShutdownCompletion {
        if self.reopen {
            self.reopen = false;
            self.phase = Phase::Running;
            ShutdownCompletion::Reopen
        } else {
            self.phase = Phase::ReadyToExit;
            ShutdownCompletion::Exit
        }
    }

    pub fn allow_exit(&self) -> bool {
        self.phase == Phase::ReadyToExit && !self.reopen
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn is_current_running(&self, generation: u64) -> bool {
        self.phase == Phase::Running && self.generation == generation
    }

    pub fn cleanup_finished(&self) -> bool {
        self.phase == Phase::ReadyToExit
    }
}
