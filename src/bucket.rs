//! A token bucket: a burst at once, then a steady rate. Discovery counts frames with it, the relay bytes.

use std::time::Instant;

pub struct Bucket {
    tokens: f64,
    burst: f64,
    per_second: f64,
    last: Instant,
}

impl Bucket {
    pub fn new(burst: f64, per_second: f64, now: Instant) -> Self {
        Bucket {
            tokens: burst,
            burst,
            per_second,
            last: now,
        }
    }

    /// Takes `cost` tokens if there are that many; false, taking none, means over the limit.
    pub fn take(&mut self, cost: f64, now: Instant) -> bool {
        let refill = now.saturating_duration_since(self.last).as_secs_f64() * self.per_second;
        self.tokens = (self.tokens + refill).min(self.burst);
        self.last = now;
        if self.tokens < cost {
            return false;
        }
        self.tokens -= cost;

        true
    }

    /// Whether it would hold its whole burst at `now`, as a new bucket does.
    pub fn is_full(&self, now: Instant) -> bool {
        self.tokens + now.saturating_duration_since(self.last).as_secs_f64() * self.per_second >= self.burst
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_burst_then_the_steady_rate_and_a_pause_refills_no_more_than_the_burst() {
        let start = Instant::now();
        let mut bucket = Bucket::new(5.0, 1.0, start);
        for frame in 0..5 {
            assert!(bucket.take(1.0, start), "frame {frame} of the burst");
        }
        assert!(!bucket.take(1.0, start), "one past the burst");
        let second = start + Duration::from_secs(1);
        assert!(bucket.take(1.0, second), "a token a second later");
        assert!(!bucket.take(1.0, second), "only one");
        let much_later = second + Duration::from_secs(60);
        for frame in 0..5 {
            assert!(bucket.take(1.0, much_later), "frame {frame}: a long pause refills the burst");
        }
        assert!(!bucket.take(1.0, much_later), "but no more than the burst");
    }

    #[test]
    fn a_cost_over_what_is_left_takes_nothing() {
        let start = Instant::now();
        let mut bucket = Bucket::new(100.0, 10.0, start);
        assert!(bucket.take(60.0, start));
        assert!(!bucket.take(60.0, start), "40 left");
        assert!(bucket.take(40.0, start), "the refused take kept the 40");
    }
}
