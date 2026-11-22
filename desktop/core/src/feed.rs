// The Feed (experiment `feed`, runner/src/experiments/feed.md): the Inbox
// drawn as one card per thread, one after another, in the main panel, as
// Mike picked on 20 Nov 2026 (feed-mockups r3-c-status). What's here is what
// it knows with no window: which threads it shows and in what order, what a
// card says at the top and in its "where it's at" box, and the messages its
// fold opens onto, read from the thread's events.
use crate::chips::{self, Piece};
use crate::inbox::{self, ThreadSummary, Wake};
use crate::reducer::ImageRef;
use chrono::{DateTime, Datelike as _, TimeZone};
use serde_json::Value;
use std::borrow::Borrow;
use std::collections::{HashMap, HashSet};

pub const EXPERIMENT: &str = "feed";

/// How many messages the fold shows before "Show N earlier messages".
pub const FOLD_SHOWS: usize = 4;

/// How far down the feed counts as scrolled away from the top, for the
/// "↑ N new" pill.
pub const AWAY_FROM_TOP: f32 = 80.;

/// Where a card stands, which picks its pill and what its box shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CardState {
    /// Waiting on Mike: a card of asks, a question or permission, a design
    /// review, or a finished turn that says it needs him.
    NeedsYou,
    /// A turn under way, or work going on in the background.
    Running,
    /// The rest of the Inbox: done, or nothing for him.
    Quiet,
}

impl CardState {
    pub fn name(self) -> &'static str {
        match self {
            CardState::NeedsYou => "needsYou",
            CardState::Running => "running",
            CardState::Quiet => "quiet",
        }
    }
}

/// Which section the sidebar would put it in, a star aside: the feed has no
/// Starred heading, so a starred thread goes where it would without its star.
fn section(t: &ThreadSummary, now_ms: i64, wakes: &HashMap<String, Wake>) -> &'static str {
    if t.is_starred() && !t.is_archived() {
        let mut plain = t.clone();
        plain.starred_at = None;
        return inbox::section_of(&plain, now_ms, wakes);
    }
    inbox::section_of(t, now_ms, wakes)
}

/// The card's state, from the sidebar's own rules: Running is what the
/// sidebar puts under Running, Needs you the Inbox's threads that want Mike.
pub fn card_state(t: &ThreadSummary, now_ms: i64, wakes: &HashMap<String, Wake>) -> CardState {
    match section(t, now_ms, wakes) {
        "running" => CardState::Running,
        _ if t.wants_you() || t.waiting_on_mike() => CardState::NeedsYou,
        _ => CardState::Quiet,
    }
}

/// The threads the feed shows, in its order: those that need Mike, then the
/// running ones, then the rest of the Inbox, each newest first (a stuck card
/// first among those that need him, as the Inbox has it). Hibernating and
/// archived threads aren't in it, except the ones in `kept`: threads Mike
/// marked Done here, which keep their place as a one-line row until he
/// leaves the feed (sorted as they were before he archived them).
pub fn feed_threads<'a, T: Borrow<ThreadSummary> + Clone + 'a>(
    threads: impl IntoIterator<Item = &'a T>,
    now_ms: i64,
    wakes: &HashMap<String, Wake>,
    kept: &HashSet<String>,
) -> Vec<T> {
    let rows: Vec<&'a T> = threads.into_iter().collect();
    let by_id: HashMap<&str, &ThreadSummary> = rows
        .iter()
        .map(|r| {
            let t: &ThreadSummary = (*r).borrow();
            (t.id.as_str(), t)
        })
        .collect();
    let mut cards: Vec<(u8, bool, i64, String, T)> = Vec::new();
    for row in rows {
        let t: &ThreadSummary = row.borrow();
        // A panel member is drawn in its lead's card.
        if t.everyone_of
            .as_deref()
            .is_some_and(|lead| by_id.contains_key(lead))
        {
            continue;
        }
        let state = if t.is_archived() && kept.contains(&t.id) {
            let mut was = t.clone();
            was.archived_at = None;
            if matches!(section(&was, now_ms, wakes), "hibernating" | "archived") {
                continue;
            }
            card_state(&was, now_ms, wakes)
        } else {
            if matches!(section(t, now_ms, wakes), "hibernating" | "archived") {
                continue;
            }
            card_state(t, now_ms, wakes)
        };
        let members: Vec<&ThreadSummary> = panel(t)
            .map(|p| {
                p.members
                    .iter()
                    .filter_map(|m| by_id.get(m.thread_id.as_str()).copied())
                    .collect()
            })
            .unwrap_or_default();
        let state = with_members(state, &members, now_ms, wakes);
        let rank = match state {
            CardState::NeedsYou => 0,
            CardState::Running => 1,
            CardState::Quiet => 2,
        };
        cards.push((
            rank,
            !t.on_card(),
            t.activity_ms(),
            t.id.clone(),
            row.clone(),
        ));
    }
    cards.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.cmp(&b.1))
            .then(b.2.cmp(&a.2))
            .then(a.3.cmp(&b.3))
    });
    cards.into_iter().map(|c| c.4).collect()
}

/// Who a card's top line is from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Starter {
    /// Mike started it: his name, then what he asked.
    Mike,
    /// Another thread started it ("Started by <its title>").
    Thread,
    /// A schedule did (its title).
    Schedule,
    /// A tool, or the runner, did (its label).
    Tool,
}

/// A card's top: whose it is, the name beside the avatar, and the line under
/// it (his request, or for one he didn't start, the thread's title).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Top {
    pub from: Starter,
    /// "Started by GPUI Port Coordinator", "Kite watch", "Sentry"; empty for Mike.
    pub name: String,
    pub line: String,
    /// The avatar's letters, for one that isn't Mike's.
    pub initials: String,
}

fn title_of(t: &ThreadSummary) -> String {
    if t.title.trim().is_empty() {
        "Untitled".to_owned()
    } else {
        t.title.clone()
    }
}

/// Up to two letters from a name's words: "GPUI Port Coordinator" is "GP".
pub fn initials(name: &str) -> String {
    let letters: String = name
        .split_whitespace()
        .filter_map(|w| w.chars().find(|c| c.is_alphanumeric()))
        .take(2)
        .collect();
    if letters.is_empty() {
        "?".to_owned()
    } else {
        letters.to_uppercase()
    }
}

/// The card's top line: Mike's first message to the thread (`request`), or
/// its title when that's missing (a thread from before it, or another Mac on
/// an older backend). For a thread he didn't start, who did and its title.
pub fn top(t: &ThreadSummary) -> Top {
    let started = t.started_by.as_ref();
    let kind = started
        .and_then(|s| s.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let label = started
        .and_then(|s| s.get("label"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let schedule = t
        .schedule
        .as_ref()
        .and_then(|s| s.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let title = title_of(t);
    if kind == "thread" || kind == "librarian" {
        let by = started
            .and_then(|s| s.get("threadTitle"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                if label.is_empty() {
                    "Agent".to_owned()
                } else {
                    label.clone()
                }
            });
        return Top {
            from: Starter::Thread,
            initials: initials(&by),
            name: format!("Started by {by}"),
            line: title,
        };
    }
    if kind == "schedule" || (started.is_none() && schedule.is_some()) {
        let name = schedule.map(str::to_owned).unwrap_or_else(|| {
            if label.is_empty() {
                "Schedule".to_owned()
            } else {
                label.clone()
            }
        });
        return Top {
            from: Starter::Schedule,
            initials: String::new(),
            name,
            line: title,
        };
    }
    if started.is_some() {
        let name = if label.is_empty() {
            "Threadbear".to_owned()
        } else {
            label
        };
        return Top {
            from: Starter::Tool,
            initials: initials(&name),
            name,
            line: title,
        };
    }
    let line = t
        .request
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or(title);
    Top {
        from: Starter::Mike,
        name: String::new(),
        line,
        initials: String::new(),
    }
}

/// The "where it's at" box's words: the latest turn's headline, its first
/// line in plain words. None before the thread has said anything.
pub fn headline(t: &ThreadSummary) -> Option<String> {
    let line = crate::sidebar::preview_plain(t.preview.lines().next().unwrap_or(""))
        .trim()
        .to_owned();
    (!line.is_empty()).then_some(line)
}

/// The headline in full, where the card has read the thread's messages: the
/// summary's is cut at 140 characters, so the first paragraph of the reply
/// it comes from, when that's the agent's last message (three lines of it
/// show). None when the messages don't say more than the summary.
pub fn fuller_headline(t: &ThreadSummary, messages: &[Message]) -> Option<String> {
    let short = headline(t)?;
    let reply = messages.iter().rev().find(|m| m.author == Author::Agent)?;
    let first = reply
        .text
        .split("\n\n")
        .map(str::trim)
        .find(|p| !p.is_empty())?;
    let para =
        crate::sidebar::preview_plain(&first.lines().map(str::trim).collect::<Vec<_>>().join(" "))
            .trim()
            .to_owned();
    let start: String = short
        .trim_end_matches('\u{2026}')
        .chars()
        .take(40)
        .collect();
    (para.len() > short.len() && para.starts_with(&start)).then_some(para)
}

/// What a running card's spinner line says: the newest background job the
/// thread has going, else "Working".
pub fn live_line(t: &ThreadSummary) -> String {
    if t.busy() {
        if t.status == "starting" {
            return "Starting".to_owned();
        }
        return "Working".to_owned();
    }
    if let Some(what) = t.waiting_to_land() {
        return what;
    }
    if t.waiting_on_work() {
        if t.awaiting_app_restart == Some(true) {
            return "Waiting for the app to restart onto it".to_owned();
        }
        let titles: Vec<String> = t
            .waiting_on
            .iter()
            .flatten()
            .filter(|w| w.get("done").and_then(Value::as_bool) != Some(true))
            .filter_map(|w| w.get("title").and_then(Value::as_str).map(str::to_owned))
            .collect();
        if let Some(first) = titles.first() {
            return format!("Waiting on {first}");
        }
    }
    t.background_tasks()
        .into_iter()
        .rev()
        .map(|b| b.description.trim().to_owned())
        .find(|d| !d.is_empty())
        .unwrap_or_else(|| "Working".to_owned())
}

/// The agent's name on the fold and its messages: "Claude", "Codex".
pub fn agent_name(provider: &str) -> String {
    match provider {
        "" | "claude" => "Claude".to_owned(),
        "codex" => "Codex".to_owned(),
        "grok" => "Grok".to_owned(),
        "opencode" => "OpenCode".to_owned(),
        "cursor" => "Cursor".to_owned(),
        "antigravity" => "Gemini".to_owned(),
        other => {
            let mut c = other.chars();
            c.next()
                .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                .unwrap_or_default()
        }
    }
}

/// The fold's words: "Claude · 9 messages", or just the agent's name before
/// its messages have been read.
pub fn fold_label(provider: &str, count: Option<usize>, more_before: bool) -> String {
    let name = agent_name(provider);
    match count {
        Some(1) if !more_before => format!("{name} \u{b7} 1 message"),
        Some(n) if more_before => format!("{name} \u{b7} {n}+ messages"),
        Some(n) => format!("{name} \u{b7} {n} messages"),
        None => name,
    }
}

/// A Done card's one line: "✓ title · headline · Undo" is drawn from these.
pub fn done_line(t: &ThreadSummary) -> (String, Option<String>) {
    (title_of(t), headline(t))
}

/// "3:10 pm" today, "Tue 3:10 pm" this week, "12 Nov" before that.
pub fn when<Tz: TimeZone>(at_ms: i64, now: &DateTime<Tz>) -> String {
    let Some(at) = now.timezone().timestamp_millis_opt(at_ms).single() else {
        return String::new();
    };
    let clock = crate::new_thread::clock(&at);
    let days = (now.clone().date_naive() - at.date_naive()).num_days();
    if days <= 0 {
        clock
    } else if days < 6 {
        const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        format!(
            "{} {clock}",
            WEEKDAYS[at.weekday().num_days_from_monday() as usize]
        )
    } else {
        const MONTHS: [&str; 12] = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        format!("{} {}", at.day(), MONTHS[at.month0() as usize])
    }
}

/// Who wrote a message in the fold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Author {
    Mike,
    Agent,
    /// The runner, a schedule or another agent sent it.
    Other,
}

/// A message in a card's fold: Mike's, or the agent's reply to a turn.
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub seq: u64,
    pub author: Author,
    /// "Schedule", "Threadbear", "Agent" for an `Other` message.
    pub by: String,
    pub text: String,
    pub at_ms: i64,
    /// The pictures pasted into a message sent to the thread, which its
    /// `[Picture N]` markers place, as Mike's bubble draws them.
    pub images: Vec<ImageRef>,
}

/// The conversation as the fold shows it, oldest first, from a page of the
/// thread's events (`threads.events`): each message Mike sent, and the
/// agent's reply to each turn (its last block of words, a narration aside).
/// Events an edit cut out (`thread.rewound`) aren't in it.
pub fn messages(events: &[Value]) -> Vec<Message> {
    let mut cut: Vec<(u64, u64)> = Vec::new();
    for e in events {
        if e.get("type").and_then(Value::as_str) == Some("thread.rewound") {
            if let (Some(from), Some(to)) = (
                e.get("fromSeq").and_then(Value::as_u64),
                e.get("toSeq").and_then(Value::as_u64),
            ) {
                cut.push((from, to));
            }
        }
    }
    let gone = |seq: u64| cut.iter().any(|(a, b)| seq >= *a && seq <= *b);
    let mut out: Vec<Message> = Vec::new();
    // The agent's reply so far in the turn under way: its message's place in
    // `out` and the turn it's for, replaced by a later block in that turn.
    let mut reply: Option<(usize, String)> = None;
    let mut items: HashMap<String, usize> = HashMap::new();
    // Turns a panel member's answer started in its lead (`everyone` on the
    // runner's message): the card shows the answer from the member's own
    // thread, and the lead's reply to it as "Where it's at".
    let mut panel_turns: HashSet<String> = HashSet::new();
    for e in events {
        let seq = e.get("seq").and_then(Value::as_u64).unwrap_or(0);
        if gone(seq) {
            continue;
        }
        let at_ms = e
            .get("ts")
            .and_then(Value::as_str)
            .and_then(inbox::parse_ms)
            .unwrap_or(0);
        let turn = e
            .get("turnId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        match e.get("type").and_then(Value::as_str) {
            Some("user.message") if e.get("everyone").and_then(Value::as_bool) == Some(true) => {
                if !turn.is_empty() {
                    panel_turns.insert(turn);
                }
                reply = None;
            }
            Some("assistant.text") if panel_turns.contains(&turn) => {}
            Some("user.message") => {
                let text = e
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_owned();
                let images: Vec<ImageRef> = e
                    .get("images")
                    .and_then(Value::as_array)
                    .map(|list| list.iter().filter_map(ImageRef::decode).collect())
                    .unwrap_or_default();
                if text.is_empty() && images.is_empty() {
                    continue;
                }
                let origin = e.get("origin").and_then(Value::as_str).unwrap_or("");
                let by_agent = e
                    .get("sentByAgent")
                    .is_some_and(|v| !v.is_null() && v != &Value::Bool(false));
                let (author, by) = match origin {
                    "runner" => (Author::Other, "Threadbear"),
                    "schedule" => (Author::Other, "Schedule"),
                    _ if by_agent => (Author::Other, "Agent"),
                    _ => (Author::Mike, ""),
                };
                out.push(Message {
                    seq,
                    author,
                    by: by.to_owned(),
                    text,
                    at_ms,
                    images,
                });
                reply = None;
            }
            Some("assistant.text") => {
                if e.get("narration").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                let text = e
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_owned();
                if text.is_empty() {
                    continue;
                }
                let item = e
                    .get("itemId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let message = Message {
                    seq,
                    author: Author::Agent,
                    by: String::new(),
                    text,
                    at_ms,
                    images: Vec::new(),
                };
                // The same block again replaces it where it stands.
                if let Some(&at) = items.get(&item).filter(|_| !item.is_empty()) {
                    if let Some(slot) = out.get_mut(at) {
                        *slot = message;
                    }
                    continue;
                }
                match &reply {
                    Some((at, t)) if *t == turn => {
                        out[*at] = message;
                        if !item.is_empty() {
                            items.insert(item, *at);
                        }
                    }
                    _ => {
                        out.push(message);
                        reply = Some((out.len() - 1, turn));
                        if !item.is_empty() {
                            items.insert(item, out.len() - 1);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// How many of a thread's first events a card reads for the pictures in
/// Mike's request: his first message is near the start of a thread he began.
pub const REQUEST_EVENTS: u64 = 20;

/// Until the request's message is read, a `[Picture N]` up to this is drawn
/// as a picture's chip with no picture yet, not as words.
const UNREAD_PICTURES: usize = 20;

/// Whether a card's request is read from its thread's first events
/// (`threads.events` from the start, `REQUEST_EVENTS` of them) for the
/// pictures pasted into it: one of Mike's on this Mac, as a picture with no
/// marker in the words still shows as a tile; another Mac's only when its
/// line names one, as each read goes through Convex.
pub fn reads_request(t: &ThreadSummary) -> bool {
    let top = top(t);
    top.from == Starter::Mike && (!t.is_remote() || top.line.contains("[Picture "))
}

/// Words as `oneLine` has them (runner.ts): each run of spaces one space.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The pictures of Mike's request, from the thread's first events: those of
/// his first message in them whose words are the request's (`request`, cut
/// to 200 with "…"). None when none is: his first message is further in, or
/// the page isn't the thread's start (another Mac's, read through the
/// relay, may be its newest rows), so no other message's pictures stand in.
pub fn request_images(first_events: &[Value], request: &str) -> Option<Vec<ImageRef>> {
    let request = one_line(request);
    let start = request.trim_end_matches('\u{2026}').trim_end();
    messages(first_events)
        .into_iter()
        .filter(|m| m.author == Author::Mike)
        .find(|m| {
            let words = one_line(&m.text);
            words == request || (!start.is_empty() && words.starts_with(start))
        })
        .map(|m| m.images)
}

/// The card's top line cut where its chips go, as Mike's bubble cuts his
/// message (`chips::message_pieces`): with the request's pictures once its
/// message is read (`images`), and before that (or when it couldn't be
/// found) each `[Picture N]` as a picture still to come, so the marker never
/// shows as words. A marker the 200-character cut went through goes too.
pub fn top_pieces(line: &str, images: Option<usize>) -> Vec<Piece> {
    // "[Pic…", "[Picture 1…": the start of a marker, with nothing after.
    let cut_marker = line.rfind('[').filter(|&at| {
        let rest = line[at..].trim_end_matches('\u{2026}');
        let open = "[Picture ";
        !rest.contains(']')
            && (open.starts_with(rest)
                || rest
                    .strip_prefix(open)
                    .is_some_and(|n| n.chars().all(|c| c.is_ascii_digit())))
    });
    let line = match cut_marker {
        Some(at) => format!("{}\u{2026}", line[..at].trim_end()),
        None => line.to_owned(),
    };
    chips::message_pieces(&line, images.unwrap_or(UNREAD_PICTURES))
}

/// One of a panel's other labs (protocol "For everyone").
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub provider: String,
    pub name: String,
    pub thread_id: String,
}

/// A lab the question didn't go to, and why: "notSignedIn", "noRoom" or
/// "failed".
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeftOut {
    pub provider: String,
    pub name: String,
    pub why: String,
}

/// A For everyone panel, read from its lead's summary.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Panel {
    pub members: Vec<Member>,
    pub missing: Vec<LeftOut>,
}

/// The panel a lead's summary carries; None for any other thread. A member
/// or a lab it can't read is left out rather than losing the rest.
pub fn panel(t: &ThreadSummary) -> Option<Panel> {
    let v = t.everyone.as_ref()?;
    let s = |o: &Value, k: &str| o.get(k).and_then(Value::as_str).map(str::to_owned);
    let members = v
        .get("members")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let provider = s(m, "provider")?;
                    Some(Member {
                        name: s(m, "name").unwrap_or_else(|| agent_name(&provider)),
                        thread_id: s(m, "threadId")?,
                        provider,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let missing = v
        .get("missing")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    let provider = s(m, "provider")?;
                    Some(LeftOut {
                        name: s(m, "name").unwrap_or_else(|| agent_name(&provider)),
                        why: s(m, "why").unwrap_or_default(),
                        provider,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Panel { members, missing })
}

/// A lead's card state with its members': one waiting on Mike makes the
/// card need him, one at work makes a quiet card a running one.
pub fn with_members(
    state: CardState,
    members: &[&ThreadSummary],
    now_ms: i64,
    wakes: &HashMap<String, Wake>,
) -> CardState {
    let states: Vec<CardState> = members
        .iter()
        .filter(|m| !m.is_archived())
        .map(|m| card_state(m, now_ms, wakes))
        .collect();
    if state == CardState::NeedsYou || states.contains(&CardState::NeedsYou) {
        CardState::NeedsYou
    } else if state == CardState::Running || states.contains(&CardState::Running) {
        CardState::Running
    } else {
        state
    }
}

/// "Codex", "Codex and Gemini", "Claude, Codex, Gemini and Grok".
pub fn names_line(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The panel's fold: "Claude, Codex, Gemini and Grok · 3 replies", or the
/// names alone before the messages have been read.
pub fn panel_fold_label(names: &[String], replies: Option<usize>) -> String {
    let who = names_line(names);
    match replies {
        Some(1) => format!("{who} \u{b7} 1 reply"),
        Some(n) => format!("{who} \u{b7} {n} replies"),
        None => who,
    }
}

/// The lines under a panel's "Where it's at": who's still at it, who wants
/// Mike in their own thread, and who was left out and why.
pub fn panel_status(working: &[String], waiting: &[String], missing: &[LeftOut]) -> Vec<String> {
    let mut out = Vec::new();
    if !working.is_empty() {
        let verb = if working.len() == 1 { "is" } else { "are" };
        out.push(format!("{} {verb} still thinking.", names_line(working)));
    }
    for name in waiting {
        out.push(format!("{name} is waiting for you in its thread."));
    }
    for m in missing {
        out.push(match m.why.as_str() {
            "notSignedIn" => format!("{} isn't signed in on this Mac, so it's left out.", m.name),
            "noRoom" => format!("{} has no login with room, so it's left out.", m.name),
            _ => format!("{} couldn't start, so it's left out.", m.name),
        });
    }
    out
}

/// A message in a panel's fold, with the thread it's from and who wrote it.
#[derive(Clone, Debug, PartialEq)]
pub struct PanelMessage {
    pub thread_id: String,
    pub provider: String,
    pub message: Message,
}

/// A panel's conversation as one: the lead's messages, and each member's
/// replies, oldest first. The question (Mike's first message, the lead's
/// and each member's copy) is the card's top line, so it's left out, and so
/// is a member's copy of a message of Mike's sent to everyone, which the
/// lead already has: the same words within ten minutes.
pub fn panel_messages(
    lead: (&str, &str, &[Message]),
    members: &[(&str, &str, &[Message])],
) -> Vec<PanelMessage> {
    const SAME_MESSAGE_MS: i64 = 10 * 60_000;
    let question = lead.2.iter().position(|m| m.author == Author::Mike);
    let mut out: Vec<PanelMessage> = lead
        .2
        .iter()
        .enumerate()
        .filter(|(i, _)| Some(*i) != question)
        .map(|(_, m)| PanelMessage {
            thread_id: lead.0.to_owned(),
            provider: lead.1.to_owned(),
            message: m.clone(),
        })
        .collect();
    for (id, provider, messages) in members {
        let mut first_mine = true;
        for m in messages.iter() {
            if m.author == Author::Mike {
                if std::mem::take(&mut first_mine) {
                    continue;
                }
                let sent_to_all = out.iter().any(|o| {
                    o.message.author == Author::Mike
                        && o.message.text == m.text
                        && (o.message.at_ms - m.at_ms).abs() <= SAME_MESSAGE_MS
                });
                if sent_to_all {
                    continue;
                }
            } else if m.author != Author::Agent {
                continue;
            }
            out.push(PanelMessage {
                thread_id: (*id).to_owned(),
                provider: (*provider).to_owned(),
                message: m.clone(),
            });
        }
    }
    out.sort_by_key(|m| m.message.at_ms);
    out
}

/// Who a panel card's reply box can send to: everyone, then each lab on it,
/// as "@everyone" and "@Codex" with the thread each one goes to (None for
/// everyone).
pub fn reply_targets(lead: &ThreadSummary, panel: &Panel) -> Vec<(String, Option<String>)> {
    let mut out = vec![("@everyone".to_owned(), None)];
    out.push((
        format!("@{}", agent_name(&lead.provider)),
        Some(lead.id.clone()),
    ));
    for m in &panel.members {
        out.push((format!("@{}", m.name), Some(m.thread_id.clone())));
    }
    out
}

/// Whether a card offers Ask the others: a thread Mike started with
/// something he asked, on this Mac's runner, not a panel or one of one.
pub fn can_ask_others(t: &ThreadSummary) -> bool {
    t.everyone.is_none()
        && t.everyone_of.is_none()
        && !t.is_remote()
        && !t.is_archived()
        && top(t).from == Starter::Mike
        && t.request.as_deref().is_some_and(|r| !r.trim().is_empty())
}

/// How many cards the "↑ N new" pill counts: ones in the feed now that
/// weren't when Mike last saw its top.
pub fn new_count<'a>(shown: impl IntoIterator<Item = &'a str>, seen: &HashSet<String>) -> usize {
    shown.into_iter().filter(|id| !seen.contains(*id)).count()
}

/// "↑ 3 new".
pub fn new_pill(count: usize) -> String {
    format!("\u{2191} {count} new")
}

/// The first word of a person's full name, for "Mike" over his messages;
/// "You" when there's none.
pub fn first_name(full: &str) -> String {
    full.split_whitespace()
        .next()
        .map(str::to_owned)
        .unwrap_or_else(|| "You".to_owned())
}

/// A card as the dump has it, one line: "[needsYou] Title: top line | where
/// it's at", with "(done)" for a Done row.
pub fn dump_line(t: &ThreadSummary, state: CardState, done: bool) -> String {
    let top = top(t);
    let head = headline(t).unwrap_or_default();
    if done {
        return format!("[done] {}: {head}", title_of(t));
    }
    format!("[{}] {}: {} | {head}", state.name(), title_of(t), top.line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_763_600_000_000;

    fn thread(id: &str, minutes_ago: i64, extra: Value) -> ThreadSummary {
        let mut v = json!({
            "id": id, "title": format!("Thread {id}"), "cwd": "/x", "provider": "claude", "accountId": "a", "permissionMode": "full",
            "status": "idle", "needsYou": false, "preview": "", "lastSeq": 3, "lastSeenSeq": 3,
            "lastActivityAt": inbox::iso_time(NOW - minutes_ago * 60_000),
        });
        for (k, val) in extra.as_object().unwrap() {
            v[k] = val.clone();
        }
        serde_json::from_value(v).unwrap()
    }

    fn ids(list: &[ThreadSummary]) -> Vec<&str> {
        list.iter().map(|t| t.id.as_str()).collect()
    }

    #[test]
    fn needs_you_then_running_then_the_rest_each_newest_first() {
        let threads = vec![
            thread("quiet_old", 50, json!({ "needs": "nothing" })),
            thread("run_old", 30, json!({ "status": "running" })),
            thread(
                "needs_old",
                40,
                json!({ "needs": "you", "needsYou": true, "asks": [{ "action": "Pick one" }], "asksSeq": 3 }),
            ),
            thread("quiet_new", 1, json!({ "needs": "nothing" })),
            thread("run_new", 2, json!({ "status": "running" })),
            thread("needs_new", 5, json!({ "needs": "you", "needsYou": true })),
            thread(
                "asleep",
                0,
                json!({ "snoozedUntil": inbox::iso_time(NOW + 3_600_000) }),
            ),
            thread("archived", 0, json!({ "archivedAt": inbox::iso_time(NOW) })),
        ];
        let shown = feed_threads(&threads, NOW, &HashMap::new(), &HashSet::new());
        assert_eq!(
            ids(&shown),
            [
                "needs_new",
                "needs_old",
                "run_new",
                "run_old",
                "quiet_new",
                "quiet_old"
            ]
        );
    }

    #[test]
    fn a_thread_stuck_on_a_card_comes_first_and_a_starred_one_goes_where_it_would() {
        let threads = vec![
            thread("needs", 1, json!({ "needs": "you", "needsYou": true })),
            thread("stuck", 30, json!({ "status": "waiting" })),
            thread(
                "starred_running",
                3,
                json!({ "status": "running", "starredAt": inbox::iso_time(NOW) }),
            ),
            thread(
                "starred_asleep",
                3,
                json!({ "starredAt": inbox::iso_time(NOW), "snoozedUntil": inbox::iso_time(NOW + 3_600_000) }),
            ),
        ];
        let shown = feed_threads(&threads, NOW, &HashMap::new(), &HashSet::new());
        assert_eq!(ids(&shown), ["stuck", "needs", "starred_running"]);
    }

    #[test]
    fn a_done_card_keeps_its_place_until_mike_leaves_the_feed() {
        let threads = vec![
            thread("a", 1, json!({ "needs": "nothing" })),
            thread(
                "done",
                2,
                json!({ "needs": "nothing", "archivedAt": inbox::iso_time(NOW) }),
            ),
            thread("b", 3, json!({ "needs": "nothing" })),
        ];
        let kept: HashSet<String> = ["done".to_owned()].into();
        assert_eq!(
            ids(&feed_threads(&threads, NOW, &HashMap::new(), &kept)),
            ["a", "done", "b"]
        );
        assert_eq!(
            ids(&feed_threads(
                &threads,
                NOW,
                &HashMap::new(),
                &HashSet::new()
            )),
            ["a", "b"]
        );
    }

    #[test]
    fn card_states() {
        let w = HashMap::new();
        assert_eq!(
            card_state(
                &thread(
                    "x",
                    1,
                    json!({ "needs": "you", "needsYou": true, "asks": [{ "action": "Go?" }] })
                ),
                NOW,
                &w
            ),
            CardState::NeedsYou
        );
        assert_eq!(
            card_state(&thread("x", 1, json!({ "status": "waiting" })), NOW, &w),
            CardState::NeedsYou
        );
        assert_eq!(
            card_state(&thread("x", 1, json!({ "status": "running" })), NOW, &w),
            CardState::Running
        );
        assert_eq!(
            card_state(
                &thread(
                    "x",
                    1,
                    json!({ "background": [{ "kind": "shell", "description": "npm test" }] })
                ),
                NOW,
                &w
            ),
            CardState::Running
        );
        assert_eq!(
            card_state(&thread("x", 1, json!({ "needs": "nothing" })), NOW, &w),
            CardState::Quiet
        );
        // A finished turn that didn't say is still something for him to read.
        assert_eq!(
            card_state(&thread("x", 1, json!({ "needsYou": true })), NOW, &w),
            CardState::NeedsYou
        );
    }

    #[test]
    fn the_top_is_mikes_request_or_who_started_it() {
        let mine = thread(
            "x",
            1,
            json!({ "title": "Bedtime Tube", "request": "Bedtime Tube hasn't put anything on my phone for ages", "asked": "and the alert?" }),
        );
        assert_eq!(
            top(&mine),
            Top {
                from: Starter::Mike,
                name: String::new(),
                line: "Bedtime Tube hasn't put anything on my phone for ages".into(),
                initials: String::new()
            }
        );
        // No request (an older runner): the title.
        assert_eq!(
            top(&thread("x", 1, json!({ "title": "Keep main green" }))).line,
            "Keep main green"
        );
        let by_thread = thread(
            "x",
            1,
            json!({ "title": "Browser pane: back button", "startedBy": { "kind": "thread", "label": "Agent", "threadId": "c", "threadTitle": "GPUI Port Coordinator" } }),
        );
        let t = top(&by_thread);
        assert_eq!(
            (
                t.from,
                t.name.as_str(),
                t.line.as_str(),
                t.initials.as_str()
            ),
            (
                Starter::Thread,
                "Started by GPUI Port Coordinator",
                "Browser pane: back button",
                "GP"
            )
        );
        let scheduled = thread(
            "x",
            1,
            json!({ "title": "Kite check", "startedBy": { "kind": "schedule", "label": "Schedule" }, "schedule": { "id": "s", "title": "Kite watch" } }),
        );
        assert_eq!(
            (top(&scheduled).from, top(&scheduled).name),
            (Starter::Schedule, "Kite watch".to_owned())
        );
        let tool = thread(
            "x",
            1,
            json!({ "title": "Sentry: TypeError", "startedBy": { "kind": "tool", "label": "Sentry" } }),
        );
        assert_eq!(
            (top(&tool).from, top(&tool).name, top(&tool).line),
            (
                Starter::Tool,
                "Sentry".to_owned(),
                "Sentry: TypeError".to_owned()
            )
        );
    }

    #[test]
    fn where_its_at_and_the_live_line() {
        let t = thread(
            "x",
            1,
            json!({ "preview": "**Fixed**, and the [backlog](https://x) is on your phone.\nmore" }),
        );
        assert_eq!(
            headline(&t).as_deref(),
            Some("Fixed, and the backlog is on your phone.")
        );
        assert_eq!(headline(&thread("x", 1, json!({}))), None);
        assert_eq!(
            live_line(&thread("x", 1, json!({ "status": "running" }))),
            "Working"
        );
        assert_eq!(
            live_line(&thread(
                "x",
                1,
                json!({ "background": [{ "kind": "shell", "description": "" }, { "kind": "monitor", "description": "Waiting on the next Desktop run" }] })
            )),
            "Waiting on the next Desktop run"
        );
    }

    #[test]
    fn the_folds_words() {
        assert_eq!(
            fold_label("claude", Some(9), false),
            "Claude \u{b7} 9 messages"
        );
        assert_eq!(
            fold_label("codex", Some(1), false),
            "Codex \u{b7} 1 message"
        );
        assert_eq!(
            fold_label("claude", Some(40), true),
            "Claude \u{b7} 40+ messages"
        );
        assert_eq!(fold_label("claude", None, false), "Claude");
        assert_eq!(new_pill(3), "\u{2191} 3 new");
        assert_eq!(first_name("Mike Cann"), "Mike");
        assert_eq!(first_name(""), "You");
    }

    #[test]
    fn the_folds_messages_are_mikes_and_each_turns_reply() {
        let events = vec![
            json!({ "seq": 1, "ts": "2026-11-20T02:00:00.000Z", "type": "user.message", "turnId": "t1", "text": "Fix the thing" }),
            json!({ "seq": 2, "type": "turn.started", "turnId": "t1" }),
            json!({ "seq": 3, "type": "assistant.text", "turnId": "t1", "itemId": "a", "text": "Looking." }),
            json!({ "seq": 4, "type": "tool.started", "turnId": "t1" }),
            json!({ "seq": 5, "type": "assistant.text", "turnId": "t1", "itemId": "b", "text": "Fixed it." }),
            json!({ "seq": 6, "type": "assistant.text", "turnId": "t1", "itemId": "n", "text": "thinking aloud", "narration": true }),
            json!({ "seq": 7, "type": "turn.completed", "turnId": "t1" }),
            json!({ "seq": 8, "type": "user.message", "turnId": "t2", "text": "Runner restarted", "origin": "runner" }),
            json!({ "seq": 9, "type": "assistant.text", "turnId": "t2", "itemId": "c", "text": "Carrying on." }),
            json!({ "seq": 10, "type": "user.message", "turnId": "t3", "text": "an edit cut this" }),
            json!({ "seq": 11, "type": "thread.rewound", "fromSeq": 10, "toSeq": 10 }),
            json!({ "seq": 12, "type": "user.message", "turnId": "t4", "text": "Thanks", "editOf": 10 }),
        ];
        let all = messages(&events);
        let got: Vec<(Author, &str, &str)> = all
            .iter()
            .map(|m| (m.author, m.by.as_str(), m.text.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                (Author::Mike, "", "Fix the thing"),
                (Author::Agent, "", "Fixed it."),
                (Author::Other, "Threadbear", "Runner restarted"),
                (Author::Agent, "", "Carrying on."),
                (Author::Mike, "", "Thanks"),
            ]
        );
        assert!(all[0].at_ms > 0);
    }

    #[test]
    fn a_request_with_a_picture_draws_it_as_mikes_bubble_does() {
        let line = "[Picture 1] on mobile, should this look different?";
        let t = thread("p", 1, json!({ "title": "Mobile", "request": line }));
        assert!(reads_request(&t));
        // One he didn't start isn't read; another Mac's only with a marker.
        let by_thread = thread(
            "q",
            1,
            json!({ "request": line, "startedBy": { "kind": "thread", "threadTitle": "Coordinator" } }),
        );
        assert!(!reads_request(&by_thread));
        assert!(reads_request(&thread(
            "r",
            1,
            json!({ "request": "No marker" })
        )));
        let on_bruce = |request: &str| {
            let mut t = thread("s", 1, json!({ "request": request }));
            t.runner_id = Some("bruce".into());
            t
        };
        assert!(!reads_request(&on_bruce("No marker")));
        assert!(reads_request(&on_bruce(line)));

        // Before the first message is read, the marker is a picture to come,
        // never the words "[Picture 1]".
        let words = |pieces: &[Piece]| -> String {
            pieces
                .iter()
                .map(|p| match p {
                    Piece::Words(w) => w.clone(),
                    Piece::Picture(i) => format!("<{i}>"),
                    Piece::Mention(m) => m.title.clone(),
                })
                .collect()
        };
        assert_eq!(
            words(&top_pieces(line, None)),
            "<0> on mobile, should this look different?"
        );

        // His first message's pictures, found among the thread's first events
        // even after the runner's own message, and an empty-worded one kept.
        let picture = json!({ "path": "/tmp/shot.png", "mediaType": "image/png", "width": 800, "height": 600 });
        let first = vec![
            json!({ "seq": 1, "type": "user.message", "turnId": "t0", "text": "Started from a phone", "origin": "runner" }),
            json!({ "seq": 2, "type": "user.message", "turnId": "t1", "text": line, "images": [picture] }),
            json!({ "seq": 3, "type": "assistant.text", "turnId": "t1", "itemId": "a", "text": "It does." }),
            json!({ "seq": 4, "type": "user.message", "turnId": "t2", "text": "", "images": [picture] }),
        ];
        let images = request_images(&first, line).unwrap_or_default();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].path, "/tmp/shot.png");
        assert_eq!(images[0].width, Some(800));
        assert_eq!(
            words(&top_pieces(line, Some(images.len()))),
            "<0> on mobile, should this look different?"
        );
        // Read, with no picture for a marker: it's words, as in the bubble.
        assert_eq!(words(&top_pieces(line, Some(0))), line);
        assert_eq!(request_images(&first[..1], line), None);
        // Only the message the request is: a later one's pictures (the
        // newest rows of another Mac's thread) never stand in for it.
        assert_eq!(request_images(&first[2..], line), None);
        // Cut at 200 with "…", its spaces run together, it's still found.
        let long = format!("{line}\n\n{}", "more words ".repeat(30));
        let cut: String = one_line(&long).chars().take(199).collect::<String>() + "\u{2026}";
        let events =
            vec![json!({ "seq": 1, "type": "user.message", "text": long, "images": [picture] })];
        assert_eq!(request_images(&events, &cut).map(|i| i.len()), Some(1));
        // A marker the cut went through isn't words.
        for cut in [
            "Look at this [Picture\u{2026}",
            "Look at this [Pic\u{2026}",
            "Look at this [Picture 1\u{2026}",
        ] {
            assert_eq!(words(&top_pieces(cut, Some(1))), "Look at this\u{2026}");
        }
        assert_eq!(
            words(&top_pieces("Look [at this\u{2026}", Some(1))),
            "Look [at this\u{2026}"
        );

        let all = messages(&first);
        assert_eq!(all.len(), 4);
        assert_eq!(all[3].author, Author::Mike);
        assert!(all[3].text.is_empty() && all[3].images.len() == 1);
    }

    #[test]
    fn the_headline_in_full_once_the_messages_are_read() {
        let long = "The guide and FAQ are written. A T3 contributor found a 4th bug caused by the custom label: Claude Code switches off MCP Tasks for a label it doesn't recognise.";
        let t = thread("x", 1, json!({ "preview": &long[..140] }));
        let said = |text: &str| {
            vec![Message {
                seq: 1,
                author: Author::Agent,
                by: String::new(),
                text: text.to_owned(),
                at_ms: 0,
                images: Vec::new(),
            }]
        };
        assert_eq!(
            fuller_headline(&t, &said(&format!("{long}\n\nMore below."))).as_deref(),
            Some(long)
        );
        // Another reply than the one the summary has: the summary's stays.
        assert_eq!(fuller_headline(&t, &said("Something else entirely.")), None);
        assert_eq!(fuller_headline(&t, &[]), None);
    }

    #[test]
    fn new_cards_are_the_ones_not_seen_at_the_top() {
        let seen: HashSet<String> = ["a".to_owned(), "b".to_owned()].into();
        assert_eq!(new_count(["c", "a", "d", "b"], &seen), 2);
    }

    #[test]
    fn times_on_a_card() {
        let zone = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
        let now = zone.with_ymd_and_hms(2026, 11, 20, 17, 0, 0).unwrap();
        let at = |d: u32, h: u32, m: u32| {
            zone.with_ymd_and_hms(2026, 11, d, h, m, 0)
                .unwrap()
                .timestamp_millis()
        };
        assert_eq!(when(at(20, 15, 10), &now), "3:10 pm");
        assert_eq!(when(at(17, 15, 10), &now), "Tue 3:10 pm");
        assert_eq!(when(at(2, 9, 0), &now), "2 Nov");
    }

    #[test]
    fn the_dump_line() {
        let t = thread(
            "x",
            1,
            json!({ "title": "Kite", "request": "Is it windy?", "preview": "19 kn WSW" }),
        );
        assert_eq!(
            dump_line(&t, CardState::Quiet, false),
            "[quiet] Kite: Is it windy? | 19 kn WSW"
        );
        assert_eq!(
            dump_line(&t, CardState::Quiet, true),
            "[done] Kite: 19 kn WSW"
        );
    }

    fn lead_and_members() -> Vec<ThreadSummary> {
        vec![
            thread(
                "lead",
                5,
                json!({ "needs": "nothing", "everyone": {
                    "members": [
                        { "provider": "codex", "name": "Codex", "threadId": "m_codex" },
                        { "provider": "grok", "name": "Grok", "threadId": "m_grok" },
                    ],
                    "missing": [{ "provider": "antigravity", "name": "Gemini", "why": "notSignedIn" }],
                } }),
            ),
            thread(
                "m_codex",
                4,
                json!({ "provider": "codex", "needs": "nothing", "everyoneOf": "lead" }),
            ),
            thread(
                "m_grok",
                1,
                json!({ "provider": "grok", "status": "running", "everyoneOf": "lead" }),
            ),
            thread("other", 30, json!({ "needs": "nothing" })),
        ]
    }

    #[test]
    fn a_panel_is_one_card_running_while_a_member_works() {
        let threads = lead_and_members();
        let shown = feed_threads(&threads, NOW, &HashMap::new(), &HashSet::new());
        assert_eq!(
            ids(&shown),
            ["lead", "other"],
            "members are in the lead's card"
        );
        let p = panel(&threads[0]).unwrap();
        assert_eq!(
            p.members
                .iter()
                .map(|m| m.name.as_str())
                .collect::<Vec<_>>(),
            ["Codex", "Grok"]
        );
        let members = [&threads[1], &threads[2]];
        assert_eq!(
            with_members(CardState::Quiet, &members, NOW, &HashMap::new()),
            CardState::Running
        );
        // A member whose lead isn't in the list shows on its own.
        let alone = feed_threads(&threads[1..], NOW, &HashMap::new(), &HashSet::new());
        assert!(ids(&alone).contains(&"m_codex"));
    }

    #[test]
    fn a_panel_card_says_who_is_on_it_and_who_was_left_out() {
        let names: Vec<String> = ["Claude", "Codex", "Gemini", "Grok"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            panel_fold_label(&names, Some(3)),
            "Claude, Codex, Gemini and Grok \u{b7} 3 replies"
        );
        assert_eq!(
            panel_fold_label(&names[..2], Some(1)),
            "Claude and Codex \u{b7} 1 reply"
        );
        assert_eq!(panel_fold_label(&names[..1], None), "Claude");
        let p = panel(&lead_and_members()[0]).unwrap();
        assert_eq!(
            panel_status(&["Grok".to_owned()], &[], &p.missing),
            [
                "Grok is still thinking.",
                "Gemini isn't signed in on this Mac, so it's left out."
            ]
        );
        assert_eq!(
            panel_status(&names[1..3], &["Grok".to_owned()], &[]),
            [
                "Codex and Gemini are still thinking.",
                "Grok is waiting for you in its thread."
            ]
        );
        let lead = &lead_and_members()[0];
        let targets: Vec<String> = reply_targets(lead, &p).into_iter().map(|t| t.0).collect();
        assert_eq!(targets, ["@everyone", "@Claude", "@Codex", "@Grok"]);
    }

    #[test]
    fn the_answers_passed_to_the_lead_and_its_summing_up_stay_out_of_the_fold() {
        let ev = |seq: u64, turn: &str, body: Value| {
            let mut e = json!({ "seq": seq, "turnId": turn, "ts": inbox::iso_time(NOW + seq as i64 * 1000) });
            for (k, v) in body.as_object().unwrap() {
                e[k] = v.clone();
            }
            e
        };
        let events = vec![
            ev(
                1,
                "t1",
                json!({ "type": "user.message", "text": "Revoke the old key?" }),
            ),
            ev(
                2,
                "t1",
                json!({ "type": "assistant.text", "text": "Wait for one good release." }),
            ),
            ev(
                3,
                "t2",
                json!({ "type": "user.message", "text": "For everyone: Codex answered.", "origin": "runner", "everyone": true }),
            ),
            ev(
                4,
                "t2",
                json!({ "type": "assistant.text", "text": "Both say wait." }),
            ),
            ev(
                5,
                "t3",
                json!({ "type": "user.message", "text": "ok wait" }),
            ),
            ev(
                6,
                "t3",
                json!({ "type": "assistant.text", "text": "Holding the key." }),
            ),
        ];
        let texts: Vec<String> = messages(&events).into_iter().map(|m| m.text).collect();
        assert_eq!(
            texts,
            [
                "Revoke the old key?",
                "Wait for one good release.",
                "ok wait",
                "Holding the key."
            ]
        );
    }

    #[test]
    fn a_panels_fold_merges_the_members_replies_in_time_order() {
        let m = |author: Author, text: &str, at: i64| Message {
            seq: at as u64,
            author,
            by: String::new(),
            text: text.to_owned(),
            at_ms: NOW + at * 60_000,
            images: Vec::new(),
        };
        let lead = vec![
            m(Author::Mike, "Revoke the old key?", 0),
            m(Author::Agent, "Claude: wait.", 3),
            m(Author::Mike, "ok wait", 20),
        ];
        let codex = vec![
            m(
                Author::Mike,
                "Revoke the old key?\n\n(Claude is answering this too...)",
                0,
            ),
            m(Author::Agent, "Codex: wait.", 6),
            m(Author::Mike, "ok wait", 20),
            m(Author::Agent, "Codex: fine.", 22),
        ];
        let grok = vec![
            m(Author::Mike, "Revoke the old key?", 0),
            m(Author::Mike, "only you, Grok?", 25),
        ];
        let merged = panel_messages(
            ("lead", "claude", &lead),
            &[("m_codex", "codex", &codex), ("m_grok", "grok", &grok)],
        );
        let said: Vec<(&str, &str)> = merged
            .iter()
            .map(|p| (p.provider.as_str(), p.message.text.as_str()))
            .collect();
        assert_eq!(
            said,
            [
                ("claude", "Claude: wait."),
                ("codex", "Codex: wait."),
                ("claude", "ok wait"),
                ("codex", "Codex: fine."),
                ("grok", "only you, Grok?"),
            ]
        );
        assert_eq!(
            merged[1].thread_id, "m_codex",
            "See full and Open thread go to its own thread"
        );
    }

    #[test]
    fn ask_the_others_is_for_a_thread_mike_started_here() {
        let mine = thread("mine", 5, json!({ "request": "Revoke the old key?" }));
        assert!(can_ask_others(&mine));
        let lead = &lead_and_members()[0];
        assert!(!can_ask_others(lead), "a panel already");
        let member = &lead_and_members()[1];
        assert!(!can_ask_others(member));
        let started = thread(
            "started",
            5,
            json!({ "request": "x", "startedBy": { "kind": "thread", "label": "Agent" } }),
        );
        assert!(!can_ask_others(&started), "not one an agent started");
        assert!(
            !can_ask_others(&thread("blank", 5, json!({}))),
            "nothing of Mike's to ask"
        );
    }
}
