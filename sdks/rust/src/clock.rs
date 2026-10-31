use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
    fn sleep(&self, duration: Duration);
}

#[derive(Debug, Clone, Default)]
pub struct RealClock;

impl Clock for RealClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

#[derive(Debug, Clone)]
pub struct VirtualClock {
    now: Arc<AtomicI64>,
}

impl VirtualClock {
    pub fn new(initial_ms: i64) -> Self {
        Self {
            now: Arc::new(AtomicI64::new(initial_ms)),
        }
    }

    pub fn advance(&self, delta_ms: i64) {
        self.now.fetch_add(delta_ms, Ordering::SeqCst);
    }

    pub fn set_time(&self, ms: i64) {
        self.now.store(ms, Ordering::SeqCst);
    }
}

impl Clock for VirtualClock {
    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }

    fn sleep(&self, duration: Duration) {
        self.advance(duration.as_millis() as i64);
    }
}

