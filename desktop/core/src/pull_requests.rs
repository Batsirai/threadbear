// A GitHub pull request opened as a tab in the side pane (the inlinePrs
// experiment; docs/protocol.md, "Pull requests"). Mike picked this, option A
// of three mockups (18 Nov 2026), after Capy opened PRs beside the chat:
// "rather than having to farm out to a browser, it's all in line, with
// everything you need and buttons."
//
// This is the part with no drawing in it: which links are PRs, what the
// runner's `github.pr` answer holds, and the words the tab shows.

use crate::reducer::event::{DiffHunk, EditDiff};
use serde::Deserialize;

/// A PR link's repo and number: `https://github.com/<owner>/<repo>/pull/<n>`,
/// with anything after the number (`/files`, `#discussion`) left off, as the
/// runner's `parsePrUrl` reads it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PrRef {
    pub owner: String,
    pub repo: String,
    pub number: u64,
}

impl PrRef {
    pub fn parse(url: &str) -> Option<PrRef> {
        let url = url.trim();
        let lower = url.to_ascii_lowercase();
        let rest = ["https://github.com/", "https://www.github.com/"].iter().find(|p| lower.starts_with(*p)).map(|p| &url[p.len()..])?;
        let mut parts = rest.splitn(4, '/');
        let (owner, repo, pull, tail) = (parts.next()?, parts.next()?, parts.next()?, parts.next().unwrap_or(""));
        let name_ok = |s: &str| !s.is_empty() && !s.starts_with('-') && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
        if !pull.eq_ignore_ascii_case("pull") || !name_ok(owner) || !name_ok(repo) {
            return None;
        }
        let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
        let after = &tail[digits.len()..];
        if !(after.is_empty() || after.starts_with(['/', '?', '#'])) {
            return None;
        }
        let number = digits.parse::<u64>().ok().filter(|n| *n > 0)?;
        Some(PrRef { owner: owner.to_owned(), repo: repo.to_owned(), number })
    }

    /// The PR's own page, with nothing after the number: the one URL each
    /// tab and state is kept under, however the link was written.
    pub fn url(&self) -> String {
        format!("https://github.com/{}/{}/pull/{}", self.owner, self.repo, self.number)
    }

    /// "#72", the tab's name.
    pub fn tab_title(&self) -> String {
        format!("#{}", self.number)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PrState {
    #[default]
    Open,
    Draft,
    Merged,
    Closed,
}

impl PrState {
    pub fn parse(s: &str) -> Option<PrState> {
        match s {
            "open" => Some(PrState::Open),
            "draft" => Some(PrState::Draft),
            "merged" => Some(PrState::Merged),
            "closed" => Some(PrState::Closed),
            _ => None,
        }
    }

    pub fn words(self) -> &'static str {
        match self {
            PrState::Open => "Open",
            PrState::Draft => "Draft",
            PrState::Merged => "Merged",
            PrState::Closed => "Closed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckState {
    Passed,
    Failed,
    Running,
    Pending,
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PrCheck {
    pub name: String,
    pub state: CheckState,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub seconds: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PrActivity {
    pub kind: String,
    pub author: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub review: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrHunk {
    pub old_start: i64,
    pub old_lines: i64,
    pub new_start: i64,
    pub new_lines: i64,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct PrFile {
    pub path: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub additions: u64,
    #[serde(default)]
    pub deletions: u64,
    #[serde(default)]
    pub hunks: Vec<PrHunk>,
    #[serde(default)]
    pub binary: bool,
}

impl PrFile {
    /// The file as the transcript's edit cards take it, for the same diff view.
    pub fn edit_diff(&self, key: &str) -> EditDiff {
        EditDiff {
            item_id: key.to_owned(),
            path: self.path.clone(),
            hunks: self.hunks.iter().map(|h| DiffHunk { old_start: h.old_start, old_lines: h.old_lines, new_start: h.new_start, new_lines: h.new_lines, lines: h.lines.clone() }).collect(),
        }
    }
}

/// The runner's `github.pr` answer. Fields it adds later are ignored.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrView {
    pub url: String,
    pub number: u64,
    pub title: String,
    pub author: String,
    #[serde(default)]
    pub state: PrState,
    #[serde(default)]
    pub head: String,
    #[serde(default)]
    pub base: String,
    #[serde(default)]
    pub additions: u64,
    #[serde(default)]
    pub deletions: u64,
    #[serde(default)]
    pub changed_files: u64,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub merged_at: Option<String>,
    #[serde(default)]
    pub closed_at: Option<String>,
    #[serde(default)]
    pub merged_by: Option<String>,
    #[serde(default)]
    pub review: String,
    #[serde(default)]
    pub mergeable: String,
    #[serde(default)]
    pub can_merge: bool,
    #[serde(default)]
    pub merge_methods: Vec<MergeMethod>,
    #[serde(default)]
    pub checks: Vec<PrCheck>,
    #[serde(default)]
    pub activity: Vec<PrActivity>,
    #[serde(default)]
    pub files: Vec<PrFile>,
    #[serde(default)]
    pub files_error: Option<String>,
    #[serde(default)]
    pub files_cut: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Rebase,
    Squash,
    Merge,
}

impl MergeMethod {
    pub const ALL: [MergeMethod; 3] = [MergeMethod::Rebase, MergeMethod::Squash, MergeMethod::Merge];

    pub fn id(self) -> &'static str {
        match self {
            MergeMethod::Rebase => "rebase",
            MergeMethod::Squash => "squash",
            MergeMethod::Merge => "merge",
        }
    }

    pub fn parse(s: &str) -> Option<MergeMethod> {
        MergeMethod::ALL.into_iter().find(|m| m.id() == s)
    }

    /// Its menu item, as GitHub names them.
    pub fn title(self) -> &'static str {
        match self {
            MergeMethod::Rebase => "Rebase and merge",
            MergeMethod::Squash => "Squash and merge",
            MergeMethod::Merge => "Create a merge commit",
        }
    }
}

/// The Merge button's method: the one Mike starred in its menu if this repo
/// allows it, else the first the repo allows.
pub fn merge_method(allowed: &[MergeMethod], starred: Option<MergeMethod>) -> Option<MergeMethod> {
    starred.filter(|m| allowed.contains(m)).or_else(|| allowed.first().copied())
}

/// The tab's three views.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum PrTab {
    #[default]
    Overview,
    Diff,
    Checks,
}

impl PrTab {
    pub const ALL: [PrTab; 3] = [PrTab::Overview, PrTab::Diff, PrTab::Checks];

    pub fn title(self) -> &'static str {
        match self {
            PrTab::Overview => "Overview",
            PrTab::Diff => "Diff",
            PrTab::Checks => "Checks",
        }
    }
}

/// The Checks row: "3 of 4 passed", "2 running", "No checks", with what
/// failed named, as few words as say it.
pub fn checks_summary(checks: &[PrCheck]) -> (String, Option<String>) {
    if checks.is_empty() {
        return ("No checks".into(), None);
    }
    let count = |s: CheckState| checks.iter().filter(|c| c.state == s).count();
    let (passed, running) = (count(CheckState::Passed), count(CheckState::Running) + count(CheckState::Pending));
    let counted = checks.iter().filter(|c| c.state != CheckState::Skipped).count();
    let failed: Vec<&str> = checks.iter().filter(|c| c.state == CheckState::Failed).map(|c| c.name.as_str()).collect();
    let mut words = if passed == counted { format!("All {counted} passed") } else { format!("{passed} of {counted} passed") };
    if running > 0 {
        words.push_str(&format!(", {running} running"));
    }
    let bad = match failed.as_slice() {
        [] => None,
        [one] => Some(format!("{one} failed")),
        [one, rest @ ..] => Some(format!("{one} and {} more failed", rest.len())),
    };
    (words, bad)
}

/// The Status row: what decides whether it can go in.
pub fn status_words(pr: &PrView) -> String {
    match pr.state {
        PrState::Merged => match &pr.merged_by {
            Some(by) => format!("Merged by {by}"),
            None => "Merged".into(),
        },
        PrState::Closed => "Closed".into(),
        PrState::Draft => "Draft".into(),
        PrState::Open => {
            let mut words = match pr.review.as_str() {
                "approved" => "Approved".to_owned(),
                "changes" => "Changes requested".to_owned(),
                "required" => "Review required".to_owned(),
                _ => "Open".to_owned(),
            };
            if pr.mergeable == "conflicts" {
                words.push_str(" · has conflicts");
            }
            words
        }
    }
}

/// A check's time: "1m 04s", "45s".
pub fn duration(seconds: u64) -> String {
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3600 {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    } else {
        format!("{}h {:02}m", seconds / 3600, (seconds % 3600) / 60)
    }
}

/// What "Ask Claude to review" sends as a new thread's first message.
pub fn review_prompt(pr: &PrView) -> String {
    format!(
        "Review this pull request: {}\n\nRead it with `gh pr view {} -R {}` and `gh pr diff`, check it out in a worktree if you need to run it, and tell me whether to merge it, with anything to ask the author. Don't merge, close or comment on it yourself.",
        pr.url,
        pr.number,
        repo_of(&pr.url).unwrap_or_default()
    )
}

/// What "Start a thread on it" sends: work on the PR, not a verdict on it.
pub fn work_prompt(pr: &PrView) -> String {
    format!("Pull request {} (\"{}\" by {}). ", pr.url, pr.title, pr.author)
}

/// The link a PR's state mark is drawn for in a reply:
/// `[\u{2060}](tbpr:<url>)` just before the PR's own link, as thread links
/// get theirs (link_marks.rs). Mike expected PR links in replies to show
/// whether they're open, merged or closed (19 Nov 2026).
pub const MARK_SCHEME: &str = "tbpr:";

/// Each PR a reply links to, its tidy url, once each in order.
pub fn pr_links(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, url) in pr_link_starts(text) {
        if !out.contains(&url) {
            out.push(url);
        }
    }
    out
}

/// `text` with a state mark's link before each link to a PR, or `text` as
/// it was when there's none. Links in code are text, so they're left alone.
pub fn with_pr_marks(text: &str) -> std::borrow::Cow<'_, str> {
    let at = pr_link_starts(text);
    if at.is_empty() {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len() + at.len() * 60);
    let mut from = 0;
    for (start, url) in at {
        out.push_str(&text[from..start]);
        out.push_str(&format!("[\u{2060}]({MARK_SCHEME}{url})"));
        from = start;
    }
    out.push_str(&text[from..]);
    std::borrow::Cow::Owned(out)
}

fn pr_link_starts(text: &str) -> Vec<(usize, String)> {
    if !text.contains("github.com/") {
        return Vec::new();
    }
    let Ok(tree) = markdown::to_mdast(text, &markdown::ParseOptions::gfm()) else { return Vec::new() };
    let mut at = Vec::new();
    crate::link_marks::collect(&tree, &mut |link| {
        let Some(start) = link.position.as_ref().map(|p| p.start.offset) else { return };
        if let Some(r) = PrRef::parse(&link.url).filter(|_| text.is_char_boundary(start)) {
            at.push((start, r.url()));
        }
    });
    at.sort_by_key(|(start, _)| *start);
    at
}

fn repo_of(url: &str) -> Option<String> {
    PrRef::parse(url).map(|r| format!("{}/{}", r.owner, r.repo))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_mark_before_each_pr_link_in_a_reply() {
        let text = "Try [#72](https://github.com/acme/app/pull/72/files) or https://github.com/acme/app/pull/77, not `https://github.com/acme/app/pull/9` or [docs](https://github.com/acme/app).";
        assert_eq!(
            with_pr_marks(text),
            "Try [\u{2060}](tbpr:https://github.com/acme/app/pull/72)[#72](https://github.com/acme/app/pull/72/files) or [\u{2060}](tbpr:https://github.com/acme/app/pull/77)https://github.com/acme/app/pull/77, not `https://github.com/acme/app/pull/9` or [docs](https://github.com/acme/app)."
        );
        assert_eq!(pr_links(text), ["https://github.com/acme/app/pull/72", "https://github.com/acme/app/pull/77"]);
        assert!(matches!(with_pr_marks("No links here"), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn pr_links_and_only_pr_links() {
        let r = PrRef::parse("https://github.com/acme/app/pull/72").unwrap();
        assert_eq!((r.owner.as_str(), r.repo.as_str(), r.number), ("acme", "app", 72));
        assert_eq!(PrRef::parse("https://github.com/acme/app/pull/72/files#diff-1").unwrap().url(), "https://github.com/acme/app/pull/72");
        assert_eq!(PrRef::parse("https://www.github.com/a.b/c-d/pull/3?x=1").unwrap().tab_title(), "#3");
        for no in ["https://github.com/acme/app/issues/72", "https://evil.com/acme/app/pull/72", "http://github.com/acme/app/pull/7", "https://github.com/-x/app/pull/1", "https://github.com/acme/app/pull/0", "https://github.com/acme/app/pull/7x", "https://github.com/acme/app/pull/"] {
            assert_eq!(PrRef::parse(no), None, "{no}");
        }
    }

    fn view(over: serde_json::Value) -> PrView {
        let mut v = json!({ "url": "https://github.com/acme/app/pull/72", "number": 72, "title": "Fewer approvals", "author": "ian", "state": "open", "unknownField": 1 });
        v.as_object_mut().unwrap().extend(over.as_object().unwrap().clone());
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn the_runners_answer_reads_with_fields_left_out() {
        let pr = view(json!({ "mergeMethods": ["rebase", "squash"], "files": [{ "path": "a.ts", "additions": 1, "hunks": [{ "oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1, "lines": ["-a", "+b"] }] }] }));
        assert_eq!(pr.merge_methods, vec![MergeMethod::Rebase, MergeMethod::Squash]);
        let diff = pr.files[0].edit_diff("k");
        assert_eq!((diff.path.as_str(), diff.hunks[0].lines.len()), ("a.ts", 2));
    }

    #[test]
    fn checks_say_what_failed() {
        let c = |name: &str, state| PrCheck { name: name.into(), state, url: None, seconds: None };
        assert_eq!(checks_summary(&[]), ("No checks".into(), None));
        assert_eq!(checks_summary(&[c("a", CheckState::Passed), c("b", CheckState::Skipped)]), ("All 1 passed".into(), None));
        assert_eq!(checks_summary(&[c("Windows", CheckState::Failed), c("b", CheckState::Passed), c("c", CheckState::Running)]), ("1 of 3 passed, 1 running".into(), Some("Windows failed".into())));
        assert_eq!(checks_summary(&[c("W", CheckState::Failed), c("L", CheckState::Failed)]).1, Some("W and 1 more failed".into()));
    }

    #[test]
    fn status_says_what_decides_a_merge() {
        assert_eq!(status_words(&view(json!({}))), "Open");
        assert_eq!(status_words(&view(json!({ "review": "approved", "mergeable": "conflicts" }))), "Approved · has conflicts");
        assert_eq!(status_words(&view(json!({ "state": "merged", "mergedBy": "mike" }))), "Merged by mike");
        assert_eq!(status_words(&view(json!({ "state": "draft" }))), "Draft");
    }

    #[test]
    fn merge_uses_the_starred_method_where_the_repo_allows_it() {
        use MergeMethod::*;
        assert_eq!(merge_method(&[Rebase, Squash], Some(Squash)), Some(Squash));
        assert_eq!(merge_method(&[Rebase, Squash], Some(Merge)), Some(Rebase));
        assert_eq!(merge_method(&[], Some(Merge)), None);
    }

    #[test]
    fn durations() {
        assert_eq!(duration(45), "45s");
        assert_eq!(duration(64), "1m 04s");
        assert_eq!(duration(3720), "1h 02m");
    }
}
