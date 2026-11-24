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

    /// A bucket drained of its whole burst at `start`, and that start.
    fn drained() -> (Bucket, Instant) {
        let start = Instant::now();
        let mut bucket = Bucket::new(5.0, 1.0, start);
        for _ in 0..5 {
            bucket.take(1.0, start);
        }

        (bucket, start)
    }

    /// A bucket with 40 of its 100 tokens left.
    fn with_forty_left() -> (Bucket, Instant) {
        let start = Instant::now();
        let mut bucket = Bucket::new(100.0, 10.0, start);
        bucket.take(60.0, start);

        (bucket, start)
    }

    #[test]
    fn a_full_bucket_takes_its_whole_burst_then_refuses_one_more() {
        let start = Instant::now();
        let mut bucket = Bucket::new(5.0, 1.0, start);

        let taken: Vec<bool> = (0..5).map(|_| bucket.take(1.0, start)).collect();
        let past = bucket.take(1.0, start);

        assert_eq!(taken, [true; 5], "every frame of the burst");
        assert!(!past, "one past the burst");
    }

    #[test]
    fn a_token_a_second_later_allows_one_take() {
        let (mut bucket, start) = drained();

        let taken = bucket.take(1.0, start + Duration::from_secs(1));

        assert!(taken, "a token a second later");
    }

    #[test]
    fn a_second_take_in_the_same_second_is_refused() {
        let (mut bucket, start) = drained();
        let second = start + Duration::from_secs(1);
        bucket.take(1.0, second);

        let taken = bucket.take(1.0, second);

        assert!(!taken, "only one");
    }

    #[test]
    fn a_long_pause_refills_the_burst_but_no_more() {
        let (mut bucket, start) = drained();
        let much_later = start + Duration::from_secs(61);

        let taken: Vec<bool> = (0..5).map(|_| bucket.take(1.0, much_later)).collect();
        let past = bucket.take(1.0, much_later);

        assert_eq!(taken, [true; 5], "a long pause refills the burst");
        assert!(!past, "but no more than the burst");
    }

    #[test]
    fn a_cost_under_what_is_left_is_taken() {
        let start = Instant::now();
        let mut bucket = Bucket::new(100.0, 10.0, start);

        let taken = bucket.take(60.0, start);

        assert!(taken);
    }

    #[test]
    fn a_cost_over_what_is_left_is_refused() {
        let (mut bucket, start) = with_forty_left();

        let taken = bucket.take(60.0, start);

        assert!(!taken, "40 left");
    }

    #[test]
    fn a_refused_take_keeps_the_remaining_tokens() {
        let (mut bucket, start) = with_forty_left();
        bucket.take(60.0, start);

        let taken = bucket.take(40.0, start);

        assert!(taken, "the refused take kept the 40");
    }
}
