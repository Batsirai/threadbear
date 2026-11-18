//! Moves the app has asked for that the runner hasn't shown yet.
//!
//! Picking a machine from the menu marks the row "Moving to …" and locks
//! the box at once, then asks the runner where the thread would go
//! (`threads.movePreview`) and starts it (`threads.move`). For another
//! runner's thread that look goes over the relay and can take a quarter of
//! a minute, and any update of the row meanwhile (its runner's list coming
//! in, a `thread.updated`) is a summary without `moving`, which took the
//! guess away: on 18 Nov 2026 Mike saw the spinner start, stop with the box
//! open again, and start once more when the move began. So the guess is
//! kept here and put back on every summary that comes in, until the runner
//! says something of its own about the move, the app gives up on it (the
//! sheet came up instead, or the runner refused), or a short while after
//! the runner took it without a word.

use std::collections::HashMap;

use serde_json::Value;

use crate::inbox::ThreadSummary;

/// How long a guess outlives the runner taking the move without showing it
/// (an older runner, or its row update lost): long enough for the runner's
/// own word to come, short enough that a box locked by a guess opens again.
pub const SHOWN_AFTER_START_MS: i64 = 30_000;

#[derive(Debug, Clone)]
struct Guess {
    moving: Value,
    /// The move's id once `threads.move` has answered.
    move_id: Option<String>,
    /// Set once `threads.move` has answered: the guess goes after this.
    until_ms: Option<i64>,
}

#[derive(Debug, Default, Clone)]
pub struct StartingMoves {
    by_thread: HashMap<String, Guess>,
}

fn state(moving: &Value) -> &str {
    moving.get("state").and_then(Value::as_str).unwrap_or("")
}

fn ended(moving: &Value) -> bool {
    matches!(state(moving), "failed" | "cancelled")
}

impl StartingMoves {
    /// Mike picked a machine: the row says it's going to `to_name`.
    pub fn start(&mut self, thread_id: &str, to: &str, to_name: &str) -> Value {
        let moving = serde_json::json!({ "moveId": "", "to": to, "toName": to_name, "state": "asking" });
        self.by_thread.insert(thread_id.to_owned(), Guess { moving: moving.clone(), move_id: None, until_ms: None });
        moving
    }

    /// `threads.move` answered with the move's id: the runner's own word on
    /// it is due, and the guess stands in for it a short while longer.
    pub fn started(&mut self, thread_id: &str, move_id: Option<&str>, now_ms: i64) {
        if let Some(g) = self.by_thread.get_mut(thread_id) {
            g.move_id = move_id.map(str::to_owned);
            g.until_ms = Some(now_ms + SHOWN_AFTER_START_MS);
        }
    }

    /// The app gave up on it: the sheet came up instead, or the runner
    /// refused the move.
    pub fn forget(&mut self, thread_id: &str) {
        self.by_thread.remove(thread_id);
    }

    /// The threads with a guess, to dress after a whole new list.
    pub fn threads(&self) -> Vec<String> {
        self.by_thread.keys().cloned().collect()
    }

    pub fn is_starting(&self, thread_id: &str) -> bool {
        self.by_thread.contains_key(thread_id)
    }

    /// A summary of the thread has come in: put the guess on it while the
    /// runner hasn't said anything of its own about this move. A move the
    /// runner shows going, or this one by its id (failed too), is its word,
    /// and the guess goes. An earlier move's failure (shown for a minute)
    /// isn't, so a second try right after one doesn't flash "Couldn't move".
    pub fn dress(&mut self, t: &mut ThreadSummary, now_ms: i64) {
        let Some(g) = self.by_thread.get(&t.id) else { return };
        if g.until_ms.is_some_and(|until| now_ms > until) {
            self.by_thread.remove(&t.id);
            return;
        }
        if let Some(m) = &t.moving {
            let this_one = g.move_id.as_deref().is_some_and(|id| m.get("moveId").and_then(Value::as_str) == Some(id));
            if this_one || !ended(m) {
                self.by_thread.remove(&t.id);
                return;
            }
        }
        t.moving = Some(g.moving.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thread(moving: Option<Value>) -> ThreadSummary {
        let mut v = json!({
            "id": "t1", "title": "Thread 1", "cwd": "/home/alex/dev/x",
            "provider": "claude", "status": "idle", "needsYou": false,
            "lastActivityAt": "2026-11-18T03:57:00Z", "preview": "", "lastSeq": 10, "lastSeenSeq": 10
        });
        if let Some(m) = moving {
            v["moving"] = m;
        }
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a_row_update_while_the_runner_looks_keeps_the_move_showing() {
        let mut s = StartingMoves::default();
        s.start("t1", "r-m5", "M5");
        // Hetzner's list comes in while the M5 works out where it would go.
        let mut t = thread(None);
        s.dress(&mut t, 1_000);
        assert_eq!(t.moving_line().as_deref(), Some("Moving to M5…"));
    }

    #[test]
    fn the_runners_own_word_takes_over() {
        let mut s = StartingMoves::default();
        s.start("t1", "r-m5", "M5");
        s.started("t1", Some("m1"), 1_000);
        let mut t = thread(Some(json!({ "moveId": "m1", "to": "r-m5", "toName": "M5", "state": "packing" })));
        s.dress(&mut t, 2_000);
        assert_eq!(t.moving.as_ref().unwrap()["state"], "packing");
        assert!(!s.is_starting("t1"));
        // and later updates are the runner's alone
        let mut t = thread(None);
        s.dress(&mut t, 3_000);
        assert!(t.moving.is_none());
    }

    #[test]
    fn this_move_failing_shows_as_failed() {
        let mut s = StartingMoves::default();
        s.start("t1", "r-m5", "M5");
        s.started("t1", Some("m1"), 1_000);
        let mut t = thread(Some(json!({ "moveId": "m1", "state": "failed", "note": "No login." })));
        s.dress(&mut t, 2_000);
        assert_eq!(t.moving.as_ref().unwrap()["state"], "failed");
    }

    #[test]
    fn an_earlier_moves_failure_doesnt_stand_in_for_a_new_try() {
        let mut s = StartingMoves::default();
        s.start("t1", "r-m5", "M5");
        let mut t = thread(Some(json!({ "moveId": "m0", "state": "failed", "note": "Changed." })));
        s.dress(&mut t, 1_000);
        assert_eq!(t.moving_line().as_deref(), Some("Moving to M5…"));
    }

    #[test]
    fn a_runner_that_never_shows_it_lets_the_box_go_after_a_while() {
        let mut s = StartingMoves::default();
        s.start("t1", "r-m5", "M5");
        s.started("t1", Some("m1"), 1_000);
        let mut t = thread(None);
        s.dress(&mut t, 1_000 + SHOWN_AFTER_START_MS);
        assert!(t.moving.is_some(), "still within the wait");
        let mut t = thread(None);
        s.dress(&mut t, 1_001 + SHOWN_AFTER_START_MS);
        assert!(t.moving.is_none());
        assert!(!s.is_starting("t1"));
    }

    #[test]
    fn a_move_given_up_on_leaves_the_row_alone() {
        let mut s = StartingMoves::default();
        s.start("t1", "r-m5", "M5");
        s.forget("t1");
        let mut t = thread(None);
        s.dress(&mut t, 1_000);
        assert!(t.moving.is_none());
    }
}
