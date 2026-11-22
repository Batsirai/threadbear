// The Feed (experiment `feed`, runner/src/experiments/feed.md): the Inbox as
// one roomy card per thread, one after another, in the main panel in place of
// the thread, as Mike picked on 20 Nov 2026 (feed-mockups r3-c-status: "basically
// our inbox, but with everything inline"). The sidebar stays as it is.
//
// A card: what Mike asked (his first message to it, `request`), or who started
// it; "Where it's at", the latest turn's headline, its asks answerable in place
// (the composer's own buttons and rows, through project_decisions.rs's
// `DecisionCard`) or a spinner line while it works; a fold with the agent's
// avatar and how many messages, which opens its recent messages inside the
// card; Done, which archives it and shrinks it to one line with Undo until
// Mike leaves the feed; Later, the hibernate menu; and a reply box on a card
// that needs him or whose fold he opened. A pill, "↑ N new", says cards came in
// while he was scrolled down. The rules with no window in them are
// threadbear_core::feed.
//
// For everyone (docs/protocol/threads.md): the box at the top starts a thread,
// with its switch on one that asks Claude, Codex, Gemini and Grok at once. That
// lead's card draws its members' answers in its fold, says who's still
// thinking or left out, and its reply box sends to everyone or to one of them.
// A card Mike started offers "Ask the others" to make it one.
use crate::app::Threadbear;
use crate::project_decisions::DecisionCard;
use crate::shell::SidebarMode;
use crate::spinner::Spinner;
use crate::style::{self, px};
use crate::{call, icons, now_ms};
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _, StyledExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use threadbear_core::chips::Piece;
use threadbear_core::feed::{self as rules, Author, CardState, Starter};
use threadbear_core::inbox::ThreadSummary;
use threadbear_core::reducer::ImageRef;

/// How many of a thread's newest events a card reads for its fold.
const EVENTS_READ: u64 = 200;
/// The feed's column, as the mockup has it.
const COLUMN: f32 = 680.;
/// Where a card's boxes start, past its avatar.
const INSET: f32 = 48.;
/// The feed's padding either side of its column, and a card's inside it.
const FEED_PAD: f32 = 28.;
const CARD_PAD: f32 = 20.;
/// The tallest a picture's tile is under a card's top line, and in its fold.
const TOP_TILE: f32 = 120.;
const FOLD_TILE: f32 = 96.;

/// A card's messages, read from its thread's events.
pub(crate) struct Loaded {
    last_seq: u64,
    messages: Vec<rules::Message>,
    more_before: bool,
    at: Instant,
}

/// The Feed's state in the app (`Threadbear::inbox_feed`).
#[derive(Default)]
pub(crate) struct FeedState {
    pub(crate) scroll: ScrollHandle,
    /// Threads marked Done here: archived, and one line with Undo until Mike
    /// leaves the feed.
    pub(crate) done: HashSet<String>,
    /// Each Done row's thread as it was archived, for the row once the
    /// app's list no longer has archived threads in it.
    done_rows: HashMap<String, Arc<ThreadSummary>>,
    /// Cards whose fold is open.
    pub(crate) folds: HashSet<String>,
    /// Messages opened with See full, by thread and seq.
    full: HashSet<(String, u64)>,
    /// Folds showing their earlier messages too.
    earlier: HashSet<String>,
    loaded: HashMap<String, Loaded>,
    loading: HashSet<String>,
    /// Each card's reply box, made the first time it's drawn.
    replies: HashMap<String, Entity<TextareaState>>,
    subs: Vec<Subscription>,
    /// Replies on their way, with their words, shown under the box with a
    /// spinner until the runner takes them.
    pub(crate) sending: HashMap<String, String>,
    /// Replies the runner refused, to put back in their box at the next draw.
    put_back: HashMap<String, String>,
    /// Each card's asks, answered in place.
    asks: HashMap<String, Entity<DecisionCard>>,
    /// The cards there when Mike last saw the top, for "↑ N new".
    seen: Option<HashSet<String>>,
    /// The pictures of each request read so far (`rules::request_images`),
    /// from its thread's first events; None for one whose message wasn't in
    /// them, whose markers stay chips with no picture.
    request_images: HashMap<String, Option<Vec<ImageRef>>>,
    /// Requests being read.
    request_reads: HashSet<String>,
    /// Requests whose read failed, tried again when Mike next opens the Feed.
    request_failed: HashSet<String>,
    /// What the picture viewer showed over the Feed when it was last drawn
    /// (`ViewerState::shown`), so the Feed draws again when that changes.
    pub(crate) viewer_drawn: Option<(u64, usize, bool)>,
    /// The box at the top that starts a new thread.
    compose: Option<Entity<TextareaState>>,
    /// Its For everyone switch: the new thread asks every lab.
    pub(crate) everyone: bool,
    /// A new thread on its way, with its words, until the runner has it.
    pub(crate) starting: Option<String>,
    /// Cards asking the others, until the runner has started them.
    pub(crate) asking_others: HashSet<String>,
    /// Who a panel card's reply goes to: its place in `rules::reply_targets`.
    reply_to: HashMap<String, usize>,
}

/// The first word of this account's full name ("Mike"), for the top of a
/// card he started and over his messages; "You" where there's none. Read
/// from the account's own record (its GECOS field), so no program runs.
fn user_name() -> &'static str {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        // SAFETY: getpwuid's record is read straight away, on one thread
        // (OnceLock), before anything else can call it again.
        #[cfg(unix)]
        let full = unsafe {
            let pw = libc::getpwuid(libc::getuid());
            if pw.is_null() || (*pw).pw_gecos.is_null() {
                String::new()
            } else {
                std::ffi::CStr::from_ptr((*pw).pw_gecos)
                    .to_string_lossy()
                    .into_owned()
            }
        };
        #[cfg(not(unix))]
        let full = String::new();
        rules::first_name(full.split(',').next().unwrap_or(""))
    })
}

impl Threadbear {
    /// The feed experiment is on for this Mac's runner.
    pub(crate) fn feed_on(&self) -> bool {
        self.experiment_on(rules::EXPERIMENT)
    }

    /// The Feed is what the main panel shows: it draws the picture viewer
    /// then, as the side pane draws it over a thread (viewer.rs).
    pub(crate) fn feed_showing(&self) -> bool {
        self.home_page() == Some(SidebarMode::Feed) && self.open_project().is_none()
    }

    /// Opens the Feed in the main panel; the sidebar shows the Inbox.
    pub(crate) fn show_feed(&mut self, cx: &mut Context<Self>) {
        if !self.feed_on() {
            return;
        }
        self.unfold_threads(cx);
        self.set_mode(SidebarMode::Feed, cx);
    }

    /// Leaving the Feed: the Done rows go, as the threads they stand for are
    /// archived, and the next visit starts from the top.
    pub(crate) fn left_feed(&mut self) {
        self.inbox_feed.done.clear();
        self.inbox_feed.done_rows.clear();
        self.inbox_feed.seen = None;
        // A read that failed goes again next time.
        self.inbox_feed.request_failed.clear();
    }

    /// A thread opened (or the new-thread page) takes the Feed's place: the
    /// sidebar is back on the Inbox.
    pub(crate) fn leave_feed_for_thread(&mut self) {
        if self.mode == SidebarMode::Feed {
            self.left_feed();
            self.mode = SidebarMode::Inbox;
        }
    }

    /// The threads the feed shows, in its order.
    pub(crate) fn feed_cards(&self) -> Vec<Arc<ThreadSummary>> {
        let wakes = threadbear_core::inbox::wakes(&self.scheduled.list);
        let gone = self
            .inbox_feed
            .done_rows
            .iter()
            .filter(|(id, _)| !self.threads.contains_key(id.as_str()))
            .map(|(_, t)| t);
        rules::feed_threads(
            self.threads.values().chain(gone),
            now_ms(),
            &wakes,
            &self.inbox_feed.done,
        )
    }

    fn feed_state_of(&self, t: &ThreadSummary) -> CardState {
        let wakes = threadbear_core::inbox::wakes(&self.scheduled.list);
        rules::card_state(t, now_ms(), &wakes)
    }

    /// The card's state with a panel's members in it (`rules::with_members`).
    fn feed_card_state(&self, t: &ThreadSummary) -> CardState {
        let wakes = threadbear_core::inbox::wakes(&self.scheduled.list);
        let members = self.feed_members(t);
        let refs: Vec<&ThreadSummary> = members.iter().map(|m| &**m).collect();
        rules::with_members(
            rules::card_state(t, now_ms(), &wakes),
            &refs,
            now_ms(),
            &wakes,
        )
    }

    /// The fold's words: "Claude · 9 messages", or on a panel "Claude, Codex,
    /// Gemini and Grok · 3 replies".
    fn feed_fold_words(&self, t: &ThreadSummary) -> String {
        let loaded = self.inbox_feed.loaded.get(&t.id);
        match rules::panel(t) {
            Some(p) => {
                let names: Vec<String> = std::iter::once(rules::agent_name(&t.provider))
                    .chain(p.members.iter().map(|m| m.name.clone()))
                    .collect();
                let replies = self.feed_panel_messages(t).map(|all| {
                    all.iter()
                        .filter(|m| m.message.author == Author::Agent)
                        .count()
                });
                rules::panel_fold_label(&names, replies)
            }
            None => rules::fold_label(
                &t.provider,
                loaded.map(|l| l.messages.len()),
                loaded.is_some_and(|l| l.more_before),
            ),
        }
    }

    /// The lines under a panel's "Where it's at": who's still thinking, who
    /// wants Mike in their own thread, who was left out.
    fn feed_panel_lines(&self, t: &ThreadSummary) -> Vec<String> {
        let Some(panel) = rules::panel(t) else {
            return Vec::new();
        };
        let wakes = threadbear_core::inbox::wakes(&self.scheduled.list);
        let (mut working, mut waiting) = (Vec::new(), Vec::new());
        for m in &panel.members {
            let Some(member) = self.threads.get(&m.thread_id) else {
                continue;
            };
            if member.is_archived() {
                continue;
            }
            match rules::card_state(member, now_ms(), &wakes) {
                CardState::Running => working.push(m.name.clone()),
                CardState::NeedsYou => waiting.push(m.name.clone()),
                CardState::Quiet => {}
            }
        }
        rules::panel_status(&working, &waiting, &panel.missing)
    }

    /// A panel's messages as one, oldest first: the lead's and each
    /// member's that this app has read. None before the lead's are read.
    fn feed_panel_messages(&self, t: &ThreadSummary) -> Option<Vec<rules::PanelMessage>> {
        let panel = rules::panel(t)?;
        let lead = self.inbox_feed.loaded.get(&t.id)?;
        let members: Vec<(&str, &str, &[rules::Message])> = panel
            .members
            .iter()
            .filter_map(|m| {
                let l = self.inbox_feed.loaded.get(&m.thread_id)?;
                Some((
                    m.thread_id.as_str(),
                    m.provider.as_str(),
                    l.messages.as_slice(),
                ))
            })
            .collect();
        Some(rules::panel_messages(
            (t.id.as_str(), t.provider.as_str(), &lead.messages),
            &members,
        ))
    }

    /// A card shows as a Done row: marked here, and archived still (a
    /// refused archive puts the card back).
    fn feed_is_done(&self, t: &ThreadSummary) -> bool {
        self.inbox_feed.done.contains(&t.id) && t.is_archived()
    }

    // ---- What a card does ----

    /// Done: archived at once, the card down to one line; back if the runner
    /// refuses (`update_thread`'s rollback), with its reason.
    pub(crate) fn feed_done(&mut self, id: &str, cx: &mut Context<Self>) {
        let at = threadbear_core::inbox::iso_time(now_ms());
        self.inbox_feed.done.insert(id.to_owned());
        self.inbox_feed.folds.remove(id);
        self.update_thread(
            id,
            move |t| t.archived_at = Some(at),
            json!({ "archived": true, "archivedBy": "mike" }),
            cx,
        );
        if let Some(t) = self.threads.get(id).cloned() {
            self.inbox_feed
                .done_rows
                .insert(id.to_owned(), Arc::new((*t).clone()));
            // A panel's members go with it; Undo brings back the lead alone,
            // as finished members put themselves away anyway.
            for m in self.feed_members(&t) {
                if !m.is_archived() {
                    let at = threadbear_core::inbox::iso_time(now_ms());
                    self.update_thread(
                        &m.id,
                        move |t| t.archived_at = Some(at),
                        json!({ "archived": true, "archivedBy": "mike" }),
                        cx,
                    );
                }
            }
        }
    }

    /// A panel lead's members, as this app has them (archived ones too).
    fn feed_members(&self, t: &ThreadSummary) -> Vec<Arc<ThreadSummary>> {
        rules::panel(t)
            .map(|p| {
                p.members
                    .iter()
                    .filter_map(|m| self.threads.get(&m.thread_id).cloned())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The top box, made the first time it's drawn.
    fn feed_compose_box(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextareaState> {
        if let Some(input) = &self.inbox_feed.compose {
            return input.clone();
        }
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Start something new\u{2026}")
                .auto_grow(1, 8)
                .submit_on_enter(true)
        });
        crate::unsent::watch_in(&input, "the Feed's new thread box", None, cx);
        let sub = cx.subscribe_in(
            &input,
            window,
            move |this, _input, ev: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { shift: false, .. } = ev {
                    this.feed_start(window, cx);
                }
            },
        );
        self.inbox_feed.subs.push(sub);
        self.inbox_feed.compose = Some(input.clone());
        input
    }

    /// Starts a thread from the top box, asking every lab with For everyone
    /// on. The box empties at once and its words show under it with a
    /// spinner till the runner has the thread; refused, they go back.
    pub(crate) fn feed_start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.inbox_feed.starting.is_some() {
            return;
        }
        let Some(input) = self.inbox_feed.compose.clone() else {
            return;
        };
        let text = input.read(cx).value().trim().to_owned();
        if text.is_empty() {
            return;
        }
        input.update(cx, |s, cx| s.set_value("", window, cx));
        self.inbox_feed.starting = Some(text.clone());
        cx.notify();
        let mut params = json!({ "text": text });
        if self.inbox_feed.everyone {
            params["everyone"] = json!(true);
        }
        let client = self.client.clone();
        cx.spawn_in(window, async move |this, cx| {
            let res = call(client, "threads.create", params).await;
            this.update_in(cx, |this, window, cx| {
                this.inbox_feed.starting = None;
                match res {
                    Ok(v) => {
                        if let Ok(t) = serde_json::from_value::<ThreadSummary>(v["thread"].clone())
                        {
                            this.threads.insert(t.id.clone(), Arc::new(t));
                        }
                        this.feed_to_top(cx);
                    }
                    Err(e) => {
                        if let Some(input) = this.inbox_feed.compose.clone() {
                            input.update(cx, |s, cx| s.set_value(text, window, cx));
                        }
                        this.show_error(e.message, cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Ask the others: the card's first question to the other labs. Its
    /// button spins and takes no more clicks until the runner has them.
    pub(crate) fn feed_ask_others(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.inbox_feed.asking_others.insert(id.to_owned()) {
            return;
        }
        cx.notify();
        let client = self.client.clone();
        let id = id.to_owned();
        cx.spawn(async move |this, cx| {
            let res = call(client, "threads.askOthers", json!({ "threadId": id })).await;
            this.update(cx, |this, cx| {
                this.inbox_feed.asking_others.remove(&id);
                match res {
                    Ok(v) => {
                        if let Ok(t) = serde_json::from_value::<ThreadSummary>(v["thread"].clone())
                        {
                            this.threads.insert(t.id.clone(), Arc::new(t));
                        }
                    }
                    Err(e) => this.show_error(e.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The next one a panel card's reply goes to: everyone, then each lab.
    pub(crate) fn feed_next_reply_to(&mut self, t: &ThreadSummary, cx: &mut Context<Self>) {
        let Some(panel) = rules::panel(t) else {
            return;
        };
        let count = rules::reply_targets(t, &panel).len();
        let at = self.inbox_feed.reply_to.entry(t.id.clone()).or_insert(0);
        *at = (*at + 1) % count.max(1);
        cx.notify();
    }

    /// A panel card's reply goes to: its chip's words, and the threads.
    fn feed_reply_target(&self, t: &ThreadSummary) -> Option<(String, Vec<String>)> {
        let panel = rules::panel(t)?;
        let targets = rules::reply_targets(t, &panel);
        let at = self.inbox_feed.reply_to.get(&t.id).copied().unwrap_or(0);
        let (label, one) = targets
            .get(at)
            .cloned()
            .unwrap_or_else(|| targets[0].clone());
        let ids = match one {
            Some(id) => vec![id],
            None => std::iter::once(t.id.clone())
                .chain(panel.members.iter().map(|m| m.thread_id.clone()))
                .collect(),
        };
        Some((label, ids))
    }

    /// Undo on a Done row: back in the Inbox at once, and a card again.
    pub(crate) fn feed_undo(&mut self, id: &str, cx: &mut Context<Self>) {
        self.inbox_feed.done.remove(id);
        // Back in the list as it was, if the list has let it go, so taking
        // the archive off shows at once.
        if let Some(t) = self
            .inbox_feed
            .done_rows
            .remove(id)
            .filter(|_| !self.threads.contains_key(id))
        {
            self.threads.insert(id.to_owned(), t);
        }
        self.unarchive_row(id, cx);
    }

    pub(crate) fn feed_toggle_fold(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.inbox_feed.folds.remove(id) {
            self.inbox_feed.folds.insert(id.to_owned());
            self.feed_load(id, cx);
        }
        cx.notify();
    }

    /// Reads a card's messages from its thread's newest events.
    fn feed_load(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.inbox_feed.loading.contains(id) {
            return;
        }
        let Some(t) = self.threads.get(id).cloned() else {
            return;
        };
        if self
            .inbox_feed
            .loaded
            .get(id)
            .is_some_and(|l| l.last_seq == t.last_seq)
        {
            return;
        }
        self.inbox_feed.loading.insert(id.to_owned());
        let client = self.client.clone();
        let id = id.to_owned();
        cx.spawn(async move |this, cx| {
            let res = call(
                client,
                "threads.events",
                json!({ "threadId": id, "limit": EVENTS_READ }),
            )
            .await;
            this.update(cx, |this, cx| {
                this.inbox_feed.loading.remove(&id);
                if let Ok(page) = res {
                    let events: Vec<Value> = page["events"].as_array().cloned().unwrap_or_default();
                    let first = events.first().and_then(|e| e["seq"].as_u64()).unwrap_or(1);
                    let last = page["lastSeq"]
                        .as_u64()
                        .or_else(|| events.last().and_then(|e| e["seq"].as_u64()))
                        .unwrap_or(t.last_seq);
                    let more_before = events.len() as u64 >= EVENTS_READ && first > 1;
                    this.inbox_feed.loaded.insert(
                        id.clone(),
                        Loaded {
                            last_seq: last.max(t.last_seq),
                            messages: rules::messages(&events),
                            more_before,
                            at: Instant::now(),
                        },
                    );
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Reads the pictures of a card's request, once: the first message of
    /// Mike's among its thread's first events, however long the thread.
    fn feed_read_request(&mut self, t: &ThreadSummary, cx: &mut Context<Self>) {
        if !rules::reads_request(t)
            || self.inbox_feed.request_images.contains_key(&t.id)
            || self.inbox_feed.request_failed.contains(&t.id)
            || !self.inbox_feed.request_reads.insert(t.id.clone())
        {
            return;
        }
        let request = rules::top(t).line;
        let client = self.client.clone();
        let id = t.id.clone();
        cx.spawn(async move |this, cx| {
            let res = call(
                client,
                "threads.events",
                json!({ "threadId": id, "afterSeq": 0, "limit": rules::REQUEST_EVENTS }),
            )
            .await;
            this.update(cx, |this, cx| {
                this.inbox_feed.request_reads.remove(&id);
                match res {
                    Ok(page) => {
                        let events: Vec<Value> =
                            page["events"].as_array().cloned().unwrap_or_default();
                        let images = rules::request_images(&events, &request);
                        this.inbox_feed.request_images.insert(id.clone(), images);
                    }
                    // Its chips with no picture, until the Feed's next opened.
                    Err(_) => {
                        this.inbox_feed.request_failed.insert(id.clone());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// The width a card's words get in points: the feed's column, as wide as
    /// it was last drawn, less the card's sides and `past` (its avatar).
    fn feed_text_width(&self, past: f32) -> f32 {
        let shown = f32::from(self.inbox_feed.scroll.bounds().size.width) / style::zoom_scale();
        let column = if shown > 0. {
            (shown - FEED_PAD * 2.).min(COLUMN)
        } else {
            COLUMN
        };
        (column - CARD_PAD * 2. - past).max(120.)
    }

    /// Where a card's chips are drawn: its thread, as Mike's bubble has it
    /// (chips.rs).
    fn feed_chip_place(
        &self,
        t: &ThreadSummary,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> crate::chips::ChipPlace {
        let me = cx.entity().downgrade();
        crate::chips::ChipPlace {
            origin: if t.is_remote() {
                crate::open_gate::Origin::OtherMac
            } else {
                crate::open_gate::Origin::ThisMac
            },
            runner_name: t
                .runner_id
                .as_deref()
                .map_or_else(|| "another Mac".to_owned(), |id| self.runner_name_of(id)),
            runner_id: t.runner_id.clone(),
            cwd: t.cwd.clone(),
            open_thread: std::rc::Rc::new(move |id, window, cx| {
                me.update(cx, |this, cx| this.open_thread_link(id, window, cx))
                    .ok();
            }),
            retina: window.scale_factor() >= 2.,
        }
    }

    /// Words of Mike's with their pictures, as his bubble draws them: each
    /// `[Picture N]` a chip among the words (and a card's or a thread's
    /// link one too), then the pictures as tiles that open the viewer.
    /// `images` is None while they're still being read: each marker's chip
    /// is there, with no picture. `lines_shown` cuts the words short (the
    /// fold's three lines). None for words with no chips and no pictures.
    #[expect(
        clippy::too_many_arguments,
        reason = "the top line and the fold's messages differ in all of these"
    )]
    fn feed_words_with_pictures(
        &mut self,
        t: &ThreadSummary,
        key: &str,
        pieces: Vec<Piece>,
        images: Option<&[ImageRef]>,
        width: f32,
        (font, line_height, tile, lines_shown): (f32, f32, f32, Option<usize>),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        use crate::chips::{self as chips, ChipKind, Token};
        let images: Vec<ImageRef> = images.map(<[ImageRef]>::to_vec).unwrap_or_default();
        // Pictures with no marker among the words still show, as tiles.
        if images.is_empty() && pieces.iter().all(|p| matches!(p, Piece::Words(_))) {
            return None;
        }
        let place = self.feed_chip_place(t, window, cx);
        let mut body = v_flex().w_full();
        let mut lines = chips::lay_out(pieces, px(width), font, window);
        if let Some(most) = lines_shown {
            lines.truncate(most);
        }
        for (n, tokens) in lines.into_iter().enumerate() {
            let mut line = h_flex().min_h(px(line_height)).items_center();
            for (at, token) in tokens.into_iter().enumerate() {
                line = line.child(match token {
                    Token::Words(words) => div()
                        .flex_none()
                        .whitespace_nowrap()
                        .child(words)
                        .into_any_element(),
                    Token::Chip(kind) => {
                        let chip_key =
                            SharedString::from(format!("feed-chip-{key}-{n}-{at}-{}", t.id));
                        let card = match &kind {
                            ChipKind::Thread { id, .. }
                                if chips::card_shown(&chip_key, chips::QUICK) =>
                            {
                                chips::thread_card(id, &self.threads, &self.logins.accounts, cx)
                            }
                            _ => None,
                        };
                        chips::chip(chip_key, kind, &images, &place, card, cx)
                    }
                });
            }
            body = body.child(line);
        }
        if !images.is_empty() {
            use crate::rows::images::{image_frames, picture_grid, pixel_size, TilesFrom};
            use crate::rows::metrics::{GRID_MAX_WIDTH, IMAGE_GAP};
            let sizes: Vec<_> = images.iter().map(pixel_size).collect();
            let (frames, height) =
                image_frames(&sizes, width, tile, GRID_MAX_WIDTH, IMAGE_GAP, false);
            let from = TilesFrom {
                runner: t.runner_id.clone(),
                runner_name: place.runner_name,
                client: self.client.clone(),
                redraw: cx.entity().downgrade().into(),
            };
            body = body.child(
                div()
                    .id(SharedString::from(format!("feed-pictures-{key}-{}", t.id)))
                    .mt(px(8.))
                    .child(picture_grid(&images, frames, height, width, &from, cx)),
            );
        }
        Some(body.into_any_element())
    }

    /// The card's messages are read once it's drawn, and again once its
    /// thread has moved on: at once with the fold open (at most every few
    /// seconds while it works), else once its turn is over.
    fn feed_refresh(&mut self, t: &ThreadSummary, cx: &mut Context<Self>) {
        if self.inbox_feed.loading.contains(&t.id) {
            return;
        }
        let open = self.inbox_feed.folds.contains(&t.id);
        let due = match self.inbox_feed.loaded.get(&t.id) {
            None => open || !t.is_remote(),
            Some(l) if l.last_seq == t.last_seq => false,
            Some(l) if open => l.at.elapsed() > Duration::from_secs(3),
            Some(_) => !t.busy() && !t.is_remote(),
        };
        if due {
            self.feed_load(&t.id, cx);
        }
    }

    /// The card's reply box, made the first time it's drawn.
    fn feed_reply_box(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextareaState> {
        if let Some(input) = self.inbox_feed.replies.get(id) {
            return input.clone();
        }
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Reply")
                .auto_grow(1, 8)
                .submit_on_enter(true)
        });
        // Its words are only here until they're sent: an update's restart
        // waits for them (unsent.rs).
        crate::unsent::watch_in(&input, "a reply box in the Feed", Some(id.to_owned()), cx);
        let thread = id.to_owned();
        let sub = cx.subscribe_in(
            &input,
            window,
            move |this, _input, ev: &InputEvent, window, cx| {
                if let InputEvent::PressEnter { shift: false, .. } = ev {
                    this.feed_send_reply(&thread, window, cx);
                }
            },
        );
        self.inbox_feed.subs.push(sub);
        self.inbox_feed.replies.insert(id.to_owned(), input.clone());
        input
    }

    /// Sends what's in a card's box to its thread, as the composer's Send
    /// does. The box empties at once and its words show under it with a
    /// spinner till the runner takes them; refused, they go back in the box.
    pub(crate) fn feed_send_reply(
        &mut self,
        id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.inbox_feed.sending.contains_key(id) {
            return;
        }
        let Some(input) = self.inbox_feed.replies.get(id).cloned() else {
            return;
        };
        let text = input.read(cx).value().trim().to_owned();
        if text.is_empty() {
            return;
        }
        input.update(cx, |s, cx| s.set_value("", window, cx));
        self.feed_send(id, text, cx);
    }

    /// Sends to the card's thread, or on a panel card to whoever its chip
    /// names (each of them for @everyone).
    fn feed_send(&mut self, id: &str, text: String, cx: &mut Context<Self>) {
        let Some(t) = self.threads.get(id).cloned() else {
            return;
        };
        let to = self
            .feed_reply_target(&t)
            .map(|(_, ids)| ids)
            .unwrap_or_else(|| vec![id.to_owned()]);
        self.inbox_feed.sending.insert(id.to_owned(), text.clone());
        cx.notify();
        let going: Vec<_> = to
            .iter()
            .filter_map(|target| self.threads.get(target).cloned())
            .map(|target| {
                let remote = target.runner_id.is_some();
                let params =
                    json!({ "threadId": target.id, "text": text, "runnerId": target.runner_id });
                crate::call_for_thread(self.client.clone(), remote, "threads.send", params)
            })
            .collect();
        let id = id.to_owned();
        cx.spawn(async move |this, cx| {
            let (mut failed, mut sent) = (None, 0);
            for call in going {
                match call.await {
                    Ok(_) => sent += 1,
                    Err(e) => {
                        failed.get_or_insert(e.message);
                    }
                }
            }
            this.update(cx, |this, cx| {
                this.inbox_feed.sending.remove(&id);
                if let Some(message) = failed {
                    // Back in the box only if nobody got it: sending again
                    // would give the rest a second copy.
                    if sent == 0 {
                        this.inbox_feed.put_back.insert(id.clone(), text);
                    }
                    this.show_error(message, cx);
                }
                // What it sent is the newest message: read again.
                this.inbox_feed.loaded.remove(&id);
                for target in &to {
                    this.inbox_feed.loaded.remove(target);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn feed_asks(&mut self, t: &ThreadSummary, cx: &mut Context<Self>) -> Entity<DecisionCard> {
        if let Some(card) = self.inbox_feed.asks.get(&t.id) {
            return card.clone();
        }
        let app = cx.entity().downgrade();
        let id = t.id.clone();
        let card = cx.new(|_| DecisionCard::for_feed(app, id));
        self.inbox_feed.asks.insert(t.id.clone(), card.clone());
        card
    }

    /// Back to the top, from the "↑ N new" pill.
    fn feed_to_top(&mut self, cx: &mut Context<Self>) {
        self.inbox_feed
            .scroll
            .set_offset(point(gpui_kit::px(0.), gpui_kit::px(0.)));
        self.inbox_feed.seen = Some(self.feed_cards().iter().map(|t| t.id.clone()).collect());
        cx.notify();
    }

    /// Scrolls a card to the top of the feed.
    #[cfg(feature = "automation")]
    fn feed_show(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(index) = self.feed_cards().iter().position(|t| t.id == id) else {
            return;
        };
        let scroll = &self.inbox_feed.scroll;
        // Where the card was last laid out, against the list's top: its top
        // goes a little under the list's.
        if let Some(item) = scroll.bounds_for_item(index) {
            let (list, now) = (scroll.bounds(), scroll.offset());
            let y = f32::from(now.y) - (f32::from(item.top()) - f32::from(list.top()) - 16.);
            scroll.set_offset(point(now.x, gpui_kit::px(y.min(0.))));
        } else {
            scroll.scroll_to_top_of_item(index);
        }
        cx.notify();
    }

    // ---- Drawing ----

    /// The Feed, in the main panel: a column of cards about 680 wide in the
    /// middle, and the "↑ N new" pill over it while new ones came in below
    /// the top.
    pub(crate) fn render_feed(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let cards = self.feed_cards();
        let ids: Vec<String> = cards.iter().map(|t| t.id.clone()).collect();
        let away = -f32::from(self.inbox_feed.scroll.offset().y) > rules::AWAY_FROM_TOP;
        let fresh = match &self.inbox_feed.seen {
            Some(seen) if away => rules::new_count(ids.iter().map(String::as_str), seen),
            _ => {
                self.inbox_feed.seen = Some(ids.iter().cloned().collect());
                0
            }
        };
        // The cards are the scrolling list's own children, so one can be
        // scrolled to by its place (`feed_show`).
        let mut column = v_flex()
            .id("feed")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.inbox_feed.scroll)
            .items_center()
            .gap(px(16.))
            .pt(px(22.))
            .pb(px(48.))
            .px(px(28.));
        let compose = self.render_compose(window, cx);
        column = column.child(div().w_full().max_w(px(COLUMN)).flex_none().child(compose));
        if cards.is_empty() {
            column = column.child(
                div()
                    .pt(px(40.))
                    .w_full()
                    .flex()
                    .justify_center()
                    .text_size(px(style::size::LABEL))
                    .text_color(style::secondary_text(cx))
                    .child("Nothing in your Inbox."),
            );
        }
        for t in &cards {
            let card = if self.feed_is_done(t) {
                self.render_done_row(t, cx)
            } else {
                self.render_feed_card(t, window, cx)
            };
            column = column.child(div().w_full().max_w(px(COLUMN)).flex_none().child(card));
        }
        let pill = (fresh > 0).then(|| {
            div()
                .absolute()
                .top(px(14.))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(crate::highlights::tipped(
                    div()
                        .id("feed-new")
                        .role(gpui_kit::Role::Button)
                        .px(px(16.))
                        .py(px(7.))
                        .rounded_full()
                        .bg(style::button_fill(cx))
                        .border_1()
                        .border_color(style::button_edge(cx))
                        .shadow(vec![BoxShadow::new(px(0.), px(6.), hsla(0., 0., 0., 0.5))
                            .blur_radius(px(20.))])
                        .text_size(px(13.5))
                        .font_medium()
                        .text_color(style::label_text(cx))
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.feed_to_top(cx)))
                        .child(rules::new_pill(fresh)),
                    "Go to the top for the new ones",
                ))
        });
        // A picture clicked on a card opens over the window, as one in a
        // thread does; the side pane leaves it to the Feed (highlights.rs).
        let (viewer, shown) = self.side.clone().update(cx, |side, cx| {
            (side.viewer_overlay(window, cx), side.viewer.shown())
        });
        // What it's drawn showing, so its closing draws the Feed again even
        // when it was opened before the Feed was (app.rs).
        self.inbox_feed.viewer_drawn = shown;
        div()
            .relative()
            .size_full()
            // The pill follows where the feed's scrolled to.
            .child(column.on_scroll(cx.listener(|_, _: &ScrollEvent, _, cx| cx.notify())))
            .children(pill)
            .children(viewer)
            .into_any_element()
    }

    /// The top box: Mike's avatar, "Start something new…", the For everyone
    /// switch with the marks of the labs it would ask, and Send. While a new
    /// thread is on its way, its words under the box with a spinner.
    fn render_compose(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let input = self.feed_compose_box(window, cx);
        let on = self.inbox_feed.everyone;
        let starting = self.inbox_feed.starting.clone();
        let secondary = style::secondary_text(cx);
        // The labs it would ask: Claude first, then those with a login here.
        let signed_in: HashSet<&str> = self
            .logins
            .accounts
            .iter()
            .filter(|a| !a.signed_out && !a.plan_ended)
            .map(|a| a.provider.as_str())
            .collect();
        let labs: Vec<&str> = ["claude", "codex", "antigravity", "grok"]
            .into_iter()
            .filter(|p| signed_in.contains(p))
            .collect();
        let left_out: Vec<String> = ["claude", "codex", "antigravity", "grok"]
            .into_iter()
            .filter(|p| !signed_in.contains(p))
            .map(rules::agent_name)
            .collect();
        let tip = if left_out.is_empty() {
            "Ask Claude, Codex, Gemini and Grok at once".to_owned()
        } else {
            format!(
                "Ask every lab at once. {} isn't signed in here, so {} left out",
                rules::names_line(&left_out),
                if left_out.len() == 1 {
                    "it's"
                } else {
                    "they're"
                }
            )
        };
        let switch = crate::highlights::tipped(
            h_flex()
                .id("feed-everyone")
                .role(gpui_kit::Role::Button)
                .flex_none()
                .items_center()
                .gap(px(6.))
                .pl(px(6.))
                .pr(px(10.))
                .py(px(3.))
                .rounded_full()
                .border_1()
                .border_color(if on {
                    style::control_accent(cx).opacity(0.7)
                } else {
                    style::hairline(cx)
                })
                .when(on, |s| s.bg(style::control_accent(cx).opacity(0.25)))
                .cursor_pointer()
                .hover(|s| s.bg(style::hover_fill(cx)))
                .text_size(px(12.5))
                .line_height(px(16.))
                .text_color(if on { style::label_text(cx) } else { secondary })
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.inbox_feed.everyone = !this.inbox_feed.everyone;
                    cx.notify();
                }))
                .child(stacked_marks(&labs, 18., !on, cx))
                .child("For everyone"),
            tip,
        );
        let send: AnyElement = if starting.is_some() {
            div()
                .flex_none()
                .size(px(26.))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    Spinner::new()
                        .icon(gpui_kit::assets::IconName::LoaderCircle)
                        .color(secondary)
                        .with_size(px(13.)),
                )
                .into_any_element()
        } else {
            crate::highlights::tipped(
                div()
                    .id("feed-start")
                    .role(gpui_kit::Role::Button)
                    .flex_none()
                    .size(px(26.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(|s| s.bg(style::hover_fill(cx))),
                if on {
                    "Start a thread that asks every lab"
                } else {
                    "Start a new thread"
                },
            )
            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.feed_start(window, cx)))
            .child(
                icons::symbol("paperplane")
                    .with_size(px(15.))
                    .text_color(secondary),
            )
            .into_any_element()
        };
        let field = crate::composer::bare_textarea(Textarea::new(&input))
            .text_size(px(14.5))
            .line_height(px(20.));
        let note = starting.map(|words| {
            h_flex()
                .ml(px(48.))
                .mt(px(6.))
                .gap(px(6.))
                .items_center()
                .text_size(px(12.5))
                .text_color(style::faint_text(cx))
                .child(div().flex_none().child("Starting:"))
                .child(div().min_w_0().truncate().child(words))
        });
        v_flex()
            .w_full()
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap(px(12.))
                    .child(person_avatar(user_name(), 36., cx))
                    .child(
                        h_flex()
                            .id("feed-compose")
                            .flex_1()
                            .min_w_0()
                            .items_center()
                            .gap(px(8.))
                            .pl(px(14.))
                            .pr(px(6.))
                            .py(px(6.))
                            .rounded(px(14.))
                            .bg(style::card_background(cx))
                            .border_1()
                            .border_color(style::card_border(cx))
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .child(div().flex_1().min_w_0().py(px(2.)).child(field))
                            .child(switch)
                            .child(send),
                    ),
            )
            .children(note)
            .into_any_element()
    }

    /// "✓ title · headline · Undo": a card marked Done, until Mike leaves the
    /// feed.
    fn render_done_row(&mut self, t: &ThreadSummary, cx: &mut Context<Self>) -> AnyElement {
        let (title, head) = rules::done_line(t);
        let id = t.id.clone();
        let faint = style::faint_text(cx);
        h_flex()
            .id(SharedString::from(format!("feed-done-{}", t.id)))
            .w_full()
            .items_center()
            .gap(px(10.))
            .px(px(16.))
            .py(px(10.))
            .rounded(px(14.))
            .bg(style::card_background(cx).opacity(0.7))
            .border_1()
            .border_color(style::card_border(cx))
            .text_size(px(14.))
            .line_height(px(18.))
            .child(
                div()
                    .flex_none()
                    .text_color(style::tick_green(cx))
                    .child("\u{2713}"),
            )
            .child(
                div()
                    .flex_none()
                    .max_w(px(260.))
                    .truncate()
                    .font_medium()
                    .text_color(style::label_text(cx))
                    .child(title),
            )
            .when_some(head, |s, head| {
                s.child(div().flex_none().text_color(faint).child("\u{b7}"))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(style::secondary_text(cx))
                            .child(head),
                    )
            })
            .child(div().flex_1())
            .child(
                crate::highlights::tipped(
                    div()
                        .id(SharedString::from(format!("feed-undo-{}", t.id)))
                        .role(gpui_kit::Role::Button)
                        .flex_none()
                        .cursor_pointer()
                        .text_color(style::link_text(cx))
                        .hover(|s| s.underline()),
                    "Put it back in your Inbox",
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.feed_undo(&id, cx)))
                .child("Undo"),
            )
            .into_any_element()
    }

    fn render_feed_card(
        &mut self,
        t: &ThreadSummary,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        self.feed_refresh(t, cx);
        self.feed_read_request(t, cx);
        let members = self.feed_members(t);
        for m in &members {
            self.feed_refresh(m, cx);
        }
        let panel = rules::panel(t);
        let own_state = self.feed_state_of(t);
        let state = self.feed_card_state(t);
        let top = rules::top(t);
        // Mike's request with its pictures, as his bubble has them.
        let request = if top.from == Starter::Mike {
            let images = self.inbox_feed.request_images.get(&t.id).cloned().flatten();
            let pieces = rules::top_pieces(&top.line, images.as_ref().map(Vec::len));
            let width = self.feed_text_width(36. + 12.);
            self.feed_words_with_pictures(
                t,
                "top",
                pieces,
                images.as_deref(),
                width,
                (15., 22., TOP_TILE, None),
                window,
                cx,
            )
        } else {
            None
        };
        let now = threadbear_core::sidebar::local_now();
        let (faint, secondary, label) = (
            style::faint_text(cx),
            style::secondary_text(cx),
            style::label_text(cx),
        );
        let started_ms = t
            .created_at
            .as_deref()
            .and_then(threadbear_core::inbox::parse_ms)
            .unwrap_or_else(|| t.activity_ms());
        let (avatar, name, meta): (AnyElement, String, String) = match top.from {
            Starter::Mike => (
                person_avatar(user_name(), 36., cx),
                user_name().to_owned(),
                if panel.is_some() {
                    format!("for everyone \u{b7} {}", rules::when(started_ms, &now))
                } else {
                    rules::when(started_ms, &now)
                },
            ),
            Starter::Thread => (
                letters_avatar(&top.initials, 36., cx),
                top.name.clone(),
                rules::when(started_ms, &now),
            ),
            Starter::Schedule => (
                symbol_avatar("clock", 36., cx),
                top.name.clone(),
                rules::when(started_ms, &now),
            ),
            Starter::Tool => (
                letters_avatar(&top.initials, 36., cx),
                top.name.clone(),
                rules::when(started_ms, &now),
            ),
        };
        let pill = (state == CardState::NeedsYou).then(|| {
            let accent = style::control_accent(cx);
            div()
                .flex_none()
                .px(px(10.))
                .py(px(2.))
                .rounded_full()
                .bg(accent.opacity(0.35))
                .text_size(px(12.))
                .line_height(px(16.))
                .font_semibold()
                .text_color(style::label_text(cx))
                .child("Needs you")
        });
        let header = h_flex()
            .w_full()
            .items_start()
            .gap(px(12.))
            .child(avatar)
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                div()
                                    .flex_shrink(1.)
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(14.))
                                    .line_height(px(20.))
                                    .font_semibold()
                                    .text_color(label)
                                    .child(name),
                            )
                            .child(
                                div()
                                    .flex_none()
                                    .text_size(px(13.))
                                    .line_height(px(20.))
                                    .text_color(faint)
                                    .child(meta),
                            )
                            .child(div().flex_1())
                            .children(pill),
                    )
                    .child(
                        div()
                            .mt(px(2.))
                            .text_size(px(15.))
                            .line_height(px(22.))
                            .text_color(label)
                            .map(|d| match request {
                                Some(drawn) => d.child(drawn),
                                None => d.child(top.line),
                            }),
                    ),
            );
        let where_box = self.render_where(t, own_state, window, cx);
        let footer = self.render_card_foot(t, cx);
        let fold_open = self.inbox_feed.folds.contains(&t.id);
        let fold = fold_open.then(|| self.render_fold(t, window, cx));
        let reply = (state == CardState::NeedsYou || fold_open || panel.is_some())
            .then(|| self.render_reply(t, window, cx));
        let _ = secondary;
        // Its own id, so the asks' controls in it are this card's to the
        // window, not the next card's of the same shape.
        v_flex()
            .id(SharedString::from(format!("feed-card-{}", t.id)))
            .w_full()
            .px(px(20.))
            .pt(px(18.))
            .pb(px(14.))
            .rounded(px(20.))
            .bg(style::card_background(cx))
            .border_1()
            .border_color(style::card_border(cx))
            .child(header)
            .child(where_box)
            .child(footer)
            .children(fold)
            .children(reply)
            .into_any_element()
    }

    /// "Where it's at": the latest turn's headline, then its asks to answer
    /// here, or while it works a spinner and what it's doing.
    fn render_where(
        &mut self,
        t: &ThreadSummary,
        state: CardState,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let now = threadbear_core::sidebar::local_now();
        let (faint, secondary) = (style::faint_text(cx), style::secondary_text(cx));
        let updated = rules::when(t.activity_ms(), &now);
        let heading = h_flex()
            .items_center()
            .gap(px(6.))
            .text_size(px(13.))
            .line_height(px(17.))
            .child(
                icons::symbol("arrow.clockwise")
                    .with_size(px(12.))
                    .text_color(secondary),
            )
            .child(
                div()
                    .font_semibold()
                    .text_color(secondary)
                    .child("Where it's at"),
            )
            .child(div().text_color(faint).child(updated));
        let mut body = v_flex().w_full().child(heading);
        let head = self
            .inbox_feed
            .loaded
            .get(&t.id)
            .and_then(|l| rules::fuller_headline(t, &l.messages))
            .or_else(|| rules::headline(t));
        if let Some(head) = head.clone() {
            body = body.child(
                div()
                    .mt(px(4.))
                    .text_size(px(15.))
                    .line_height(px(22.))
                    .line_clamp(3)
                    .overflow_hidden()
                    .text_color(style::label_text(cx))
                    .child(head),
            );
        }
        let waiting_asks = threadbear_core::projects::is_waiting(t);
        if state == CardState::NeedsYou && waiting_asks {
            let card = self.feed_asks(t, cx);
            let sending = threadbear_core::projects::is_sending(
                t,
                self.projects.decision_sends.get(&t.id).map(|s| s.asks_seq),
            );
            card.update(cx, |card, _| {
                card.prepare(t);
                card.mark_sending(sending);
            });
            let asks = card.update(cx, |card, cx| card.render_asks(window, cx));
            body = body.child(div().w_full().pt(px(6.)).child(asks));
        } else if t.status == "waiting" {
            let id = t.id.clone();
            body = body.child(
                h_flex()
                    .mt(px(8.))
                    .gap(px(8.))
                    .items_center()
                    .text_size(px(13.5))
                    .text_color(secondary)
                    .child("It's waiting for you to answer in the thread.")
                    .child(crate::project_page::small_push_button(
                        SharedString::from(format!("feed-answer-{}", t.id)),
                        "Open thread",
                        "Open the thread to answer it",
                        cx,
                        cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.open_thread_from_page(id.clone(), window, cx)
                        }),
                    )),
            );
        } else if state == CardState::Running {
            body = body.child(
                h_flex()
                    .mt(px(8.))
                    .gap(px(8.))
                    .items_center()
                    .text_size(px(13.5))
                    .line_height(px(18.))
                    .text_color(secondary)
                    .child(
                        div().flex_none().size(px(12.)).child(
                            Spinner::new()
                                .icon(gpui_kit::assets::IconName::LoaderCircle)
                                .color(secondary)
                                .with_size(px(12.)),
                        ),
                    )
                    .child(div().min_w_0().truncate().child(rules::live_line(t))),
            );
        } else if head.is_none() {
            body = body.child(
                div()
                    .mt(px(4.))
                    .text_size(px(14.))
                    .text_color(faint)
                    .child("Nothing said yet."),
            );
        }
        for line in self.feed_panel_lines(t) {
            body = body.child(
                div()
                    .mt(px(4.))
                    .text_size(px(14.))
                    .line_height(px(20.))
                    .text_color(secondary)
                    .child(line),
            );
        }
        div()
            .id(SharedString::from(format!("feed-where-{}", t.id)))
            .mt(px(14.))
            .ml(px(INSET))
            .px(px(14.))
            .py(px(12.))
            .rounded(px(14.))
            .bg(style::answer_rows_fill(cx))
            .border_1()
            .border_color(style::hairline(cx))
            .child(body)
            .into_any_element()
    }

    /// The fold with the agent's avatar and how many messages, Done and Later.
    fn render_card_foot(&mut self, t: &ThreadSummary, cx: &mut Context<Self>) -> AnyElement {
        let open = self.inbox_feed.folds.contains(&t.id);
        let panel = rules::panel(t);
        let words = self.feed_fold_words(t);
        let marks: AnyElement = match &panel {
            Some(p) => {
                let providers: Vec<&str> = std::iter::once(t.provider.as_str())
                    .chain(p.members.iter().map(|m| m.provider.as_str()))
                    .collect();
                stacked_marks(&providers, 22., false, cx)
            }
            None => agent_avatar(&t.provider, 22., cx),
        };
        let (secondary, label) = (style::secondary_text(cx), style::label_text(cx));
        let (fold_id, done_id, later_id) = (t.id.clone(), t.id.clone(), t.id.clone());
        let fold = crate::highlights::tipped(
            h_flex()
                .id(SharedString::from(format!("feed-fold-{}", t.id)))
                .role(gpui_kit::Role::Button)
                .items_center()
                .gap(px(8.))
                .pl(px(5.))
                .pr(px(12.))
                .py(px(4.))
                .rounded_full()
                .bg(if open {
                    style::chip_fill(cx)
                } else {
                    style::chip_hover_fill(cx)
                })
                .hover(|s| s.bg(style::chip_fill(cx)))
                .cursor_pointer()
                .text_size(px(13.))
                .line_height(px(16.))
                .text_color(if open { label } else { secondary })
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.feed_toggle_fold(&fold_id, cx)
                }))
                .child(marks)
                .child(words)
                .child(
                    icons::symbol(if open { "chevron.up" } else { "chevron.down" })
                        .with_size(px(11.))
                        .text_color(secondary),
                ),
            if open {
                "Fold the messages away"
            } else {
                "Show its recent messages"
            },
        );
        let done = foot_button(
            SharedString::from(format!("feed-done-button-{}", t.id)),
            "checkmark",
            "Done",
            "Archive it",
            cx,
            cx.listener(move |this, _: &ClickEvent, _, cx| this.feed_done(&done_id, cx)),
        );
        let later = foot_button(
            SharedString::from(format!("feed-later-{}", t.id)),
            "clock",
            "Later",
            "Hibernate it until later",
            cx,
            cx.listener(move |this, ev: &ClickEvent, window, cx| {
                this.open_hibernate_menu(later_id.clone(), ev.position(), window, cx)
            }),
        );
        let ask_others = (self.feed_on() && rules::can_ask_others(t)).then(|| {
            if self.inbox_feed.asking_others.contains(&t.id) {
                h_flex()
                    .items_center()
                    .gap(px(6.))
                    .px(px(10.))
                    .py(px(4.))
                    .text_size(px(13.))
                    .line_height(px(16.))
                    .text_color(secondary)
                    .child(
                        Spinner::new()
                            .icon(gpui_kit::assets::IconName::LoaderCircle)
                            .color(secondary)
                            .with_size(px(12.)),
                    )
                    .child("Asking the others")
                    .into_any_element()
            } else {
                let id = t.id.clone();
                foot_button(
                    SharedString::from(format!("feed-ask-others-{}", t.id)),
                    "person.3",
                    "Ask the others",
                    "Put your first question to the other labs too",
                    cx,
                    cx.listener(move |this, _: &ClickEvent, _, cx| this.feed_ask_others(&id, cx)),
                )
            }
        });
        // Wraps in a narrow panel rather than pushing Done and Later out of
        // the card: a panel's fold names four labs.
        h_flex()
            .mt(px(12.))
            .ml(px(INSET))
            .flex_wrap()
            .items_center()
            .gap(px(6.))
            .child(fold)
            .child(done)
            .child(later)
            .children(ask_others)
            .into_any_element()
    }

    /// The fold, open: its newest messages, each cut to three lines with See
    /// full and Open thread, and Show N earlier messages over them.
    fn render_fold(
        &mut self,
        t: &ThreadSummary,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut list = v_flex()
            .w_full()
            .mt(px(12.))
            .pt(px(12.))
            .border_t_1()
            .border_color(style::hairline(cx));
        let panel_messages = self.feed_panel_messages(t);
        let Some(loaded) = self.inbox_feed.loaded.get(&t.id) else {
            return list
                .child(
                    h_flex()
                        .ml(px(INSET))
                        .gap(px(8.))
                        .items_center()
                        .text_size(px(13.))
                        .text_color(style::secondary_text(cx))
                        .child(
                            Spinner::new()
                                .icon(gpui_kit::assets::IconName::LoaderCircle)
                                .with_size(px(12.)),
                        )
                        .child("Reading its messages"),
                )
                .into_any_element();
        };
        // Each message with the thread it's in and who wrote it: a panel's
        // from its members' threads too.
        let all: Vec<rules::PanelMessage> = panel_messages.unwrap_or_else(|| {
            loaded
                .messages
                .iter()
                .map(|m| rules::PanelMessage {
                    thread_id: t.id.clone(),
                    provider: t.provider.clone(),
                    message: m.clone(),
                })
                .collect()
        });
        let showing_earlier = self.inbox_feed.earlier.contains(&t.id);
        let start = if showing_earlier {
            0
        } else {
            all.len().saturating_sub(rules::FOLD_SHOWS)
        };
        if start > 0 {
            let id = t.id.clone();
            let n = start;
            list = list.child(
                div()
                    .id(SharedString::from(format!("feed-earlier-{}", t.id)))
                    .role(gpui_kit::Role::Button)
                    .ml(px(INSET))
                    .mb(px(10.))
                    .cursor_pointer()
                    .text_size(px(13.))
                    .text_color(style::link_text(cx))
                    .hover(|s| s.underline())
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.inbox_feed.earlier.insert(id.clone());
                        cx.notify();
                    }))
                    .child(if n == 1 {
                        "Show 1 earlier message".to_owned()
                    } else {
                        format!("Show {n} earlier messages")
                    }),
            );
        }
        if all.is_empty() {
            list = list.child(
                div()
                    .ml(px(INSET))
                    .text_size(px(13.))
                    .text_color(style::faint_text(cx))
                    .child("No messages yet."),
            );
        }
        let messages: Vec<rules::PanelMessage> = all[start..].to_vec();
        for m in messages {
            let of = self
                .threads
                .get(&m.thread_id)
                .cloned()
                .unwrap_or_else(|| Arc::new(t.clone()));
            list = list.child(self.render_fold_message(&of, &m.provider, &m.message, window, cx));
        }
        list.into_any_element()
    }

    fn render_fold_message(
        &mut self,
        t: &ThreadSummary,
        provider: &str,
        m: &rules::Message,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        // The thread the message is in: a panel member's for its replies.
        let thread_id = t.id.as_str();
        let now = threadbear_core::sidebar::local_now();
        let (avatar, name) = match m.author {
            Author::Mike => (person_avatar(user_name(), 32., cx), user_name().to_owned()),
            Author::Agent => (agent_avatar(provider, 32., cx), rules::agent_name(provider)),
            Author::Other => (
                letters_avatar(&rules::initials(&m.by), 32., cx),
                m.by.clone(),
            ),
        };
        let key = (thread_id.to_owned(), m.seq);
        let full = self.inbox_feed.full.contains(&key);
        // Mike's with its pictures, as his bubble has them, its words cut
        // to three lines and its pictures under them.
        let pictured = if m.author == Author::Mike {
            let pieces = threadbear_core::chips::message_pieces(&m.text, m.images.len());
            let width = self.feed_text_width(32. + 12.);
            self.feed_words_with_pictures(
                t,
                &format!("fold-{}", m.seq),
                pieces,
                Some(&m.images),
                width,
                (14.5, 21., FOLD_TILE, (!full).then_some(3)),
                window,
                cx,
            )
        } else {
            None
        };
        let text = if full { m.text.clone() } else { plain(&m.text) };
        let words = div()
            .mt(px(1.))
            .text_size(px(14.5))
            .line_height(px(21.))
            .text_color(style::label_text(cx))
            .map(|d| match pictured {
                Some(drawn) => d.child(drawn),
                None => d
                    .when(!full, |s| s.line_clamp(3).overflow_hidden())
                    .child(text),
            });
        let (open_id, see_key) = (thread_id.to_owned(), key);
        let links = h_flex()
            .mt(px(4.))
            .gap(px(16.))
            .text_size(px(12.5))
            .text_color(style::faint_text(cx))
            .child(
                crate::highlights::tipped(
                    h_flex()
                        .id(SharedString::from(format!(
                            "feed-full-{}-{}",
                            thread_id, m.seq
                        )))
                        .role(gpui_kit::Role::Button)
                        .gap(px(4.))
                        .items_center()
                        .cursor_pointer()
                        .hover(|s| s.text_color(style::secondary_text(cx))),
                    if full {
                        "Cut it back to three lines"
                    } else {
                        "See all of this message"
                    },
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    if !this.inbox_feed.full.remove(&see_key) {
                        this.inbox_feed.full.insert(see_key.clone());
                    }
                    cx.notify();
                }))
                .child(
                    icons::symbol(if full { "chevron.up" } else { "chevron.down" })
                        .with_size(px(10.)),
                )
                .child(if full { "Less" } else { "See full" }),
            )
            .child(
                crate::highlights::tipped(
                    h_flex()
                        .id(SharedString::from(format!(
                            "feed-open-{}-{}",
                            thread_id, m.seq
                        )))
                        .role(gpui_kit::Role::Button)
                        .gap(px(4.))
                        .items_center()
                        .cursor_pointer()
                        .hover(|s| s.text_color(style::secondary_text(cx))),
                    "Open thread",
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    this.open_thread_from_page(open_id.clone(), window, cx)
                }))
                .child(icons::symbol("arrow.up.forward.square").with_size(px(11.)))
                .child("Open thread"),
            );
        h_flex()
            .w_full()
            .items_start()
            .gap(px(12.))
            .pt(px(6.))
            .pb(px(8.))
            .child(avatar)
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        h_flex()
                            .gap(px(6.))
                            .items_baseline()
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .font_semibold()
                                    .text_color(style::label_text(cx))
                                    .child(name),
                            )
                            .child(
                                div()
                                    .text_size(px(12.5))
                                    .text_color(style::faint_text(cx))
                                    .child(rules::when(m.at_ms, &now)),
                            ),
                    )
                    .child(words)
                    .child(links),
            )
            .into_any_element()
    }

    /// The reply box: what's typed goes to the thread as the composer sends
    /// it. While it's on its way, its words under the box with a spinner.
    fn render_reply(
        &mut self,
        t: &ThreadSummary,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let input = self.feed_reply_box(&t.id, window, cx);
        if let Some(text) = self.inbox_feed.put_back.remove(&t.id) {
            input.update(cx, |s, cx| s.set_value(text, window, cx));
        }
        let sending = self.inbox_feed.sending.get(&t.id).cloned();
        let secondary = style::secondary_text(cx);
        let id = t.id.clone();
        let send: AnyElement = if sending.is_some() {
            div()
                .flex_none()
                .size(px(26.))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    Spinner::new()
                        .icon(gpui_kit::assets::IconName::LoaderCircle)
                        .color(secondary)
                        .with_size(px(13.)),
                )
                .into_any_element()
        } else {
            crate::highlights::tipped(
                div()
                    .id(SharedString::from(format!("feed-send-{}", t.id)))
                    .role(gpui_kit::Role::Button)
                    .flex_none()
                    .size(px(26.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(|s| s.bg(style::hover_fill(cx))),
                "Send it to the thread",
            )
            .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                this.feed_send_reply(&id, window, cx)
            }))
            .child(
                icons::symbol("paperplane")
                    .with_size(px(15.))
                    .text_color(secondary),
            )
            .into_any_element()
        };
        let field = crate::composer::bare_textarea(Textarea::new(&input))
            .text_size(px(14.))
            .line_height(px(20.));
        // On a panel card, who it goes to: @everyone, or one lab. A click
        // moves it on to the next.
        let chip = self.feed_reply_target(t).map(|(label, _)| {
            let thread = t.clone();
            crate::highlights::tipped(
                div()
                    .id(SharedString::from(format!("feed-reply-to-{}", t.id)))
                    .role(gpui_kit::Role::Button)
                    .flex_none()
                    .px(px(8.))
                    .py(px(1.))
                    .rounded(px(6.))
                    .bg(style::chip_fill(cx))
                    .border_1()
                    .border_color(style::hairline(cx))
                    .cursor_pointer()
                    .hover(|s| s.bg(style::chip_hover_fill(cx)))
                    .text_size(px(12.5))
                    .line_height(px(18.))
                    .text_color(style::secondary_text(cx))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.feed_next_reply_to(&thread, cx)
                    }))
                    .child(label),
                "Who this goes to: click for the next",
            )
        });
        let note = sending.map(|words| {
            h_flex()
                .ml(px(44.))
                .mt(px(6.))
                .gap(px(6.))
                .items_center()
                .text_size(px(12.5))
                .text_color(style::faint_text(cx))
                .child(div().flex_none().child("Sending:"))
                .child(div().min_w_0().truncate().child(words))
        });
        v_flex()
            .w_full()
            .mt(px(12.))
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap(px(12.))
                    .child(person_avatar(user_name(), 32., cx))
                    .child(
                        h_flex()
                            .id(SharedString::from(format!("feed-reply-{}", t.id)))
                            .flex_1()
                            .min_w_0()
                            .items_end()
                            .gap(px(8.))
                            .pl(px(12.))
                            .pr(px(6.))
                            .py(px(5.))
                            .rounded(px(14.))
                            .bg(style::composer_fill(cx))
                            .border_1()
                            .border_color(style::hairline(cx))
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .children(chip.map(|c| div().flex_none().pb(px(2.)).child(c)))
                            .child(div().flex_1().min_w_0().py(px(2.)).child(field))
                            .child(send),
                    ),
            )
            .children(note)
            .into_any_element()
    }

    /// The Feed in the dump (`feed`): one line a card, as `rules::dump_line`
    /// says it, with "(sending)" while an answer or a reply is on its way and
    /// "(open: N)" with its fold's messages.
    #[cfg(feature = "automation")]
    pub(crate) fn feed_dump(&self) -> Value {
        let cards = self.feed_cards();
        let lines: Vec<Value> = cards
            .iter()
            .map(|t| {
                let done = self.feed_is_done(t);
                let state = self.feed_card_state(t);
                let sending = threadbear_core::projects::is_sending(t, self.projects.decision_sends.get(&t.id).map(|s| s.asks_seq)) || self.inbox_feed.sending.contains_key(&t.id);
                let open = self.inbox_feed.folds.contains(&t.id);
                let loaded = self.inbox_feed.loaded.get(&t.id);
                json!({
                    "id": t.id,
                    "title": t.title,
                    "line": rules::dump_line(t, state, done),
                    "state": if done { "done" } else { state.name() },
                    "top": rules::top(t).line,
                    "pictures": self.inbox_feed.request_images.get(&t.id).and_then(Option::as_ref).map_or(0, Vec::len),
                    "fold": self.feed_fold_words(t),
                    "open": open,
                    "messages": if open {
                        self.feed_panel_messages(t)
                            .map(|all| all.into_iter().map(|m| m.message.text).collect::<Vec<_>>())
                            .or_else(|| loaded.map(|l| l.messages.iter().map(|m| m.text.clone()).collect()))
                            .unwrap_or_default()
                    } else { vec![] },
                    "forEveryone": rules::panel(t).is_some(),
                    "members": rules::panel(t).map(|p| p.members.iter().map(|m| json!({ "name": m.name, "threadId": m.thread_id })).collect::<Vec<_>>()).unwrap_or_default(),
                    "panelLines": self.feed_panel_lines(t),
                    "replyTo": self.feed_reply_target(t).map(|(label, _)| label),
                    "askOthers": rules::can_ask_others(t),
                    "askingOthers": self.inbox_feed.asking_others.contains(&t.id),
                    "sending": sending,
                    "reply": !done && (state == CardState::NeedsYou || open),
                })
            })
            .collect();
        json!({
            "title": "Feed",
            "cards": lines,
            "compose": {
                "everyone": self.inbox_feed.everyone,
                "starting": self.inbox_feed.starting,
            },
        })
    }
}

/// A message's words as one block of plain text for its three clipped lines:
/// markdown's marks out, its lines kept.
fn plain(text: &str) -> String {
    text.lines()
        .map(threadbear_core::sidebar::preview_plain)
        .collect::<Vec<_>>()
        .join("\n")
}

/// The fold's and footer's quiet buttons: a symbol and a word, a pill on hover.
fn foot_button(
    id: SharedString,
    symbol: &'static str,
    label: &'static str,
    tip: &'static str,
    cx: &App,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let color = style::secondary_text(cx);
    crate::highlights::tipped(
        h_flex()
            .id(id)
            .role(gpui_kit::Role::Button)
            .items_center()
            .gap(px(6.))
            .px(px(10.))
            .py(px(4.))
            .rounded_full()
            .cursor_pointer()
            .hover(|s| s.bg(style::hover_fill(cx)))
            .text_size(px(13.))
            .line_height(px(16.))
            .text_color(color)
            .on_click(on_click)
            .child(icons::symbol(symbol).with_size(px(13.)).text_color(color))
            .child(label),
        tip,
    )
    .into_any_element()
}

/// A round avatar with letters in it.
fn letters_avatar(letters: &str, size: f32, cx: &App) -> AnyElement {
    let ink = if cx.theme().is_dark() { 1. } else { 0. };
    div()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .bg(hsla(0., 0., ink, 0.12))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(size * 0.34))
        .font_semibold()
        .text_color(style::secondary_text(cx))
        .child(letters.to_owned())
        .into_any_element()
}

/// The person's avatar: their initial on a grey circle.
fn person_avatar(name: &str, size: f32, cx: &App) -> AnyElement {
    let ink = if cx.theme().is_dark() { 1. } else { 0. };
    div()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .bg(hsla(0., 0., ink, 0.2))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(size * 0.4))
        .font_semibold()
        .text_color(style::label_text(cx))
        .child(
            name.chars()
                .next()
                .map(|c| c.to_uppercase().collect::<String>())
                .unwrap_or_default(),
        )
        .into_any_element()
}

/// A schedule's avatar: its clock.
fn symbol_avatar(symbol: &'static str, size: f32, cx: &App) -> AnyElement {
    let ink = if cx.theme().is_dark() { 1. } else { 0. };
    div()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .bg(hsla(0., 0., ink, 0.08))
        .flex()
        .items_center()
        .justify_center()
        .child(
            icons::symbol(symbol)
                .with_size(px(size * 0.5))
                .text_color(style::secondary_text(cx)),
        )
        .into_any_element()
}

/// The agent's avatar: its maker's mark on a dark circle (Claude's coral).
fn agent_avatar(provider: &str, size: f32, cx: &App) -> AnyElement {
    let (fill, ink) = match provider {
        "" | "claude" => (
            hsla(18. / 360., 0.2, 0.15, 1.),
            hsla(15. / 360., 0.63, 0.6, 1.),
        ),
        _ => (hsla(0., 0., 0.16, 1.), hsla(0., 0., 0.95, 1.)),
    };
    let _ = cx;
    div()
        .flex_none()
        .size(px(size))
        .rounded_full()
        .bg(fill)
        .flex()
        .items_center()
        .justify_center()
        .child(
            icons::provider_mark(provider)
                .with_size(px(size * 0.55))
                .text_color(ink),
        )
        .into_any_element()
}

/// The labs' marks, overlapping a little, as the For everyone switch and a
/// panel's fold show them. `dim`: the switch while it's off.
fn stacked_marks(providers: &[&str], size: f32, dim: bool, cx: &App) -> AnyElement {
    let ring = style::card_background(cx);
    let mut row = h_flex().flex_none().items_center();
    for (i, p) in providers.iter().enumerate() {
        row = row.child(
            div()
                .flex_none()
                .when(i > 0, |s| s.ml(px(-size * 0.3)))
                .rounded_full()
                .border_1()
                .border_color(ring)
                .when(dim, |s| s.opacity(0.6))
                .child(agent_avatar(p, size, cx)),
        );
    }
    row.into_any_element()
}

/// `feed`, as a script drives it: `open` shows the Feed; with `thread` (its
/// id or title), `fold` (true or false) opens or folds its messages, `full`
/// (a message's seq) opens one, `done` marks it Done, `undo` puts it back,
/// `reply` sends those words from its box, `pick` "ask:choice" answers as a
/// click does (both from 1, 0 for Something else), `show` scrolls it to the
/// top, `askOthers` presses Ask the others, `replyTo` ("@Codex") moves its
/// reply chip to that lab; `top` scrolls to the top. `everyone` (true or
/// false) sets the top box's switch, `compose` puts words in it, `start`
/// sends them.
/// Says the feed after, as the dump does.
#[cfg(feature = "automation")]
pub(crate) fn automation(
    app: &Entity<Threadbear>,
    cmd: &Value,
    window: &mut Window,
    cx: &mut App,
) -> Result<Value, String> {
    if !app.read(cx).feed_on() {
        return Err("the feed experiment is off".to_owned());
    }
    if cmd["open"].as_bool() == Some(true) {
        app.update(cx, |t, cx| t.show_feed(cx));
    }
    if cmd["top"].as_bool() == Some(true) {
        app.update(cx, |t, cx| t.feed_to_top(cx));
    }
    if let Some(on) = cmd["everyone"].as_bool() {
        app.update(cx, |t, cx| {
            t.inbox_feed.everyone = on;
            cx.notify();
        });
    }
    if let Some(words) = cmd["compose"].as_str() {
        let words = words.to_owned();
        app.update(cx, |t, cx| {
            let input = t.feed_compose_box(window, cx);
            input.update(cx, |s, cx| s.set_value(words, window, cx));
        });
    }
    if cmd["start"].as_bool() == Some(true) {
        app.update(cx, |t, cx| t.feed_start(window, cx));
    }
    if let Some(key) = cmd["thread"].as_str() {
        let thread = {
            let t = app.read(cx);
            let cards = t.feed_cards();
            let titles = cards
                .iter()
                .map(|s| s.title.clone())
                .collect::<Vec<_>>()
                .join(", ");
            cards
                .iter()
                .find(|s| s.id == key || s.title == key)
                .map(|s| (**s).clone())
                .ok_or_else(|| format!("no card for {key}; there are {titles}"))?
        };
        let id = thread.id.clone();
        if cmd["show"].as_bool() == Some(true) {
            app.update(cx, |t, cx| t.feed_show(&id, cx));
        }
        if let Some(open) = cmd["fold"].as_bool() {
            app.update(cx, |t, cx| {
                if t.inbox_feed.folds.contains(&id) != open {
                    t.feed_toggle_fold(&id, cx);
                }
            });
        }
        if let Some(seq) = cmd["full"].as_u64() {
            app.update(cx, |t, cx| {
                t.inbox_feed.full.insert((id.clone(), seq));
                cx.notify();
            });
        }
        if cmd["done"].as_bool() == Some(true) {
            app.update(cx, |t, cx| t.feed_done(&id, cx));
        }
        if cmd["undo"].as_bool() == Some(true) {
            app.update(cx, |t, cx| t.feed_undo(&id, cx));
        }
        if cmd["askOthers"].as_bool() == Some(true) {
            app.update(cx, |t, cx| t.feed_ask_others(&id, cx));
        }
        if let Some(to) = cmd["replyTo"].as_str() {
            // Moves the chip on until it says `to` ("@Codex").
            for _ in 0..8 {
                let now = app
                    .read(cx)
                    .feed_reply_target(&thread)
                    .map(|(label, _)| label);
                if now.as_deref().is_none_or(|l| l == to) {
                    break;
                }
                app.update(cx, |t, cx| t.feed_next_reply_to(&thread, cx));
            }
        }
        if let Some(words) = cmd["reply"].as_str() {
            let words = words.to_owned();
            app.update(cx, |t, cx| {
                let input = t.feed_reply_box(&id, window, cx);
                input.update(cx, |s, cx| s.set_value(words, window, cx));
                t.feed_send_reply(&id, window, cx);
            });
        }
        if let Some(pick) = cmd["pick"].as_str() {
            use crate::composer_card::AskHost as _;
            let card = app.update(cx, |t, cx| t.feed_asks(&thread, cx));
            card.update(cx, |card, _| card.prepare(&thread));
            let asks = threadbear_core::projects::decision_asks(&thread);
            let parts: Vec<usize> = pick.split(':').filter_map(|p| p.parse().ok()).collect();
            let [ask, choice] = parts.as_slice() else {
                return Err(format!("no choice {pick}"));
            };
            let Some(the_ask) = asks.get(ask.wrapping_sub(1)) else {
                return Err(format!("no choice {pick}"));
            };
            if *choice > threadbear_core::composer::choices(the_ask).len() {
                return Err(format!("no choice {pick}"));
            }
            let option = if *choice == 0 {
                threadbear_core::composer::OWN_ANSWER
            } else {
                *choice as i64 - 1
            };
            let ask = ask - 1;
            card.update(cx, |card, cx| card.ask_pick_answer(ask, option, window, cx));
        }
    }
    Ok(app.read(cx).feed_dump())
}
