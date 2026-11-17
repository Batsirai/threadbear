// Live marks before links to other threads in a reply (rich.threadlinkmarks).
// An agent that starts or waits on other threads links them as
// `[title](thread:<id>)`; the app draws a small copy of that thread's sidebar
// tile just before the link, saying how it's getting on: the sidebar's
// turning arc round it while it works, a small orange badge when it needs
// Mike, a red one if it failed, a tick once it's said it's done. Mike picked
// this (option C of three mockups, 17 Nov 2026, after Capy's animated marks
// on thread references; ~/dev/me/misc/threadbear-juice-mockups/
// thread-link-marks-c.html).
//
// This is the part with no drawing in it: which state a thread's mark shows,
// and where the marks go in a reply's markdown.

use crate::inbox::ThreadSummary;
use crate::sidebar::{RowLook, RowStatus};
use std::borrow::Cow;

/// The link a mark is drawn for: `[\u{2060}](tbmark:<id>)`, put just before
/// the thread's own link so that link stays a link and wraps with the words
/// round it. The word joiner gives the parser link words that show as
/// nothing if a renderer without the mark draws it.
pub const SCHEME: &str = "tbmark:";

/// What a thread's mark says, one thing at a time (one mark, one meaning).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkMark {
    /// Working now, or a background job of its turn is: the turning arc.
    Working,
    /// Waiting on Mike: an orange badge, as the sidebar's dot.
    NeedsYou,
    /// Its last turn failed: a red badge.
    Failed,
    /// Finished and said nothing waits on Mike: a tick.
    Done,
    /// None of those (stopped, or idle without saying it's done): the tile
    /// alone, so it never claims more than it knows.
    Idle,
}

impl LinkMark {
    /// The mark for `t`, from the same reading of it its sidebar row has.
    pub fn of(t: &ThreadSummary) -> LinkMark {
        let look = RowLook::of(t, None);
        match look.status {
            RowStatus::Working | RowStatus::Background => LinkMark::Working,
            RowStatus::NeedsYou => LinkMark::NeedsYou,
            RowStatus::Failed => LinkMark::Failed,
            _ if t.needs_you => LinkMark::NeedsYou,
            RowStatus::Time if t.said_done() => LinkMark::Done,
            _ => LinkMark::Idle,
        }
    }

    /// Its words, for the mark's tooltip and for scripts.
    pub fn words(self) -> &'static str {
        match self {
            LinkMark::Working => "Working",
            LinkMark::NeedsYou => "Needs you",
            LinkMark::Failed => "Failed",
            LinkMark::Done => "Done",
            LinkMark::Idle => "Idle",
        }
    }
}

/// `text` with a mark's link before each `[words](thread:<id>)` naming a
/// thread `known` says the app has, or `text` as it was when there's none.
/// Links in code (a span or a block) are text, so they're left alone: the
/// markdown parser finds the links, not a scan of the characters.
pub fn with_marks<'a>(text: &'a str, known: &dyn Fn(&str) -> bool) -> Cow<'a, str> {
    if !text.contains("](thread:") {
        return Cow::Borrowed(text);
    }
    let Ok(tree) = markdown::to_mdast(text, &markdown::ParseOptions::gfm()) else { return Cow::Borrowed(text) };
    let mut at: Vec<(usize, String)> = Vec::new();
    collect(&tree, &mut |link| {
        let Some(id) = link.url.strip_prefix("thread:") else { return };
        let id = crate::open_policy::percent_decode(id);
        let Some(start) = link.position.as_ref().map(|p| p.start.offset) else { return };
        if crate::thread_link::is_thread_id(&id) && known(&id) && text.is_char_boundary(start) {
            at.push((start, id));
        }
    });
    if at.is_empty() {
        return Cow::Borrowed(text);
    }
    at.sort_by_key(|(start, _)| *start);
    let mut out = String::with_capacity(text.len() + at.len() * 48);
    let mut from = 0;
    for (start, id) in at {
        out.push_str(&text[from..start]);
        out.push_str(&format!("[\u{2060}]({SCHEME}{id})"));
        from = start;
    }
    out.push_str(&text[from..]);
    Cow::Owned(out)
}

fn collect(node: &markdown::mdast::Node, found: &mut impl FnMut(&markdown::mdast::Link)) {
    if let markdown::mdast::Node::Link(link) = node {
        found(link);
    }
    for child in node.children().into_iter().flatten() {
        collect(child, found);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thread(over: serde_json::Value) -> ThreadSummary {
        let mut v = json!({ "id": "t", "title": "A thread", "cwd": "/Users/alex/dev/misc", "status": "idle", "lastActivityAt": "2026-11-09T08:00:00Z", "preview": "", "lastSeq": 5, "lastSeenSeq": 5 });
        v.as_object_mut().unwrap().extend(over.as_object().unwrap().clone());
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn a_threads_mark_follows_its_row() {
        assert_eq!(LinkMark::of(&thread(json!({ "status": "running" }))), LinkMark::Working);
        assert_eq!(LinkMark::of(&thread(json!({ "status": "waiting" }))), LinkMark::NeedsYou);
        assert_eq!(LinkMark::of(&thread(json!({ "status": "error" }))), LinkMark::Failed);
        assert_eq!(LinkMark::of(&thread(json!({ "needs": "nothing" }))), LinkMark::Done);
        assert_eq!(LinkMark::of(&thread(json!({ "needs": "you", "needsYou": true }))), LinkMark::NeedsYou);
    }

    #[test]
    fn an_idle_thread_that_never_said_it_was_done_claims_nothing() {
        assert_eq!(LinkMark::of(&thread(json!({}))), LinkMark::Idle);
        assert_eq!(LinkMark::of(&thread(json!({ "status": "stopped" }))), LinkMark::Idle);
    }

    #[test]
    fn a_mark_goes_before_each_known_threads_link() {
        let known = |id: &str| id == "abc-1" || id == "def-2";
        let text = "See [Triage PRs](thread:abc-1) and [Write the guide](thread:def-2).";
        assert_eq!(with_marks(text, &known), "See [\u{2060}](tbmark:abc-1)[Triage PRs](thread:abc-1) and [\u{2060}](tbmark:def-2)[Write the guide](thread:def-2).");
    }

    #[test]
    fn unknown_threads_code_and_other_links_are_left_alone() {
        let known = |id: &str| id == "abc-1";
        for text in ["[Gone](thread:zzz-9)", "`[Triage](thread:abc-1)`", "```\n[Triage](thread:abc-1)\n```", "[A page](https://example.com)", "no links at all"] {
            assert!(matches!(with_marks(text, &known), Cow::Borrowed(_)), "{text}");
        }
    }

    #[test]
    fn a_link_after_non_ascii_words_still_gets_its_mark() {
        let known = |id: &str| id == "abc-1";
        assert_eq!(with_marks("Café ✓ [Triage](thread:abc-1)", &known), "Café ✓ [\u{2060}](tbmark:abc-1)[Triage](thread:abc-1)");
    }
}
