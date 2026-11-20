// A design review as a page in the pane beside its thread (the reviewPage
// experiment), in place of the review window: the agent's lead, then each
// option with its words at the thread's reading size and its pictures under
// them. Mike, 20 Nov 2026: he went into the window for the pictures and back
// out to the thread to read about them, the window's words being 12pt grey
// in a column 270pt wide. He picked the page on the right over one growing
// in the thread, and asked that the pane open wide enough by itself.
//
// The page's HTML is threadbear_core::review_page's, in the app's own
// colours and font, shown in the pane's sealed page view with its scripts
// off (web_panels::made_page). A tick or a picture is a link the view hands
// here (`review_asked`): a tick saves the review's draft on the runner, and
// shows on the page where it stands; a picture opens
// full size in the review window, at that shot. The ticks show over the
// message box, and sending it sends them with its words as the review's
// answer (composer.rs, `send_review_answer`), so there's no reply box here.
//
// While a review's page is on show the pane is as wide as it wants
// (`review_page::pane_width`), and back to what it was afterwards (shell.rs
// keeps what it was, and leaves a width Mike dragged alone).
use crate::call;
use crate::highlights::{palette, PanePreview, SidePane, Target};
use crate::style::{self, px};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use threadbear_client::runner::RpcError;
use threadbear_core::inbox::ThreadSummary;
use threadbear_core::local_preview::Site;
use threadbear_core::open_policy::Origin;
use threadbear_core::reducer::{DesignReview, ImageRef, RowContent};
use threadbear_core::review_page::{self as rules, Ask, Look};

pub(crate) const EXPERIMENT: &str = "reviewPage";

/// Whether the experiment's on, as the runner's `hello` said: a global, so
/// the message box can ask without reading the app.
struct On(bool);
impl Global for On {}

pub(crate) fn set_on(on: bool, cx: &mut App) {
    cx.set_global(On(on));
}

pub(crate) fn is_on(cx: &App) -> bool {
    cx.try_global::<On>().is_some_and(|on| on.0)
}

/// A review open in a thread's pane.
struct Open {
    review: DesignReview,
    /// The ticks on show: the review's draft, with a click's change at once.
    picked: Vec<String>,
    /// Its page's view (web_panels' key): a new one for each opening, and
    /// when the app's look changes.
    key: String,
    site: Option<Arc<Site>>,
    /// What the page was last made from, and the page: made again only when
    /// one of these changes, and loaded again only if it then reads differently.
    made_from: Option<(i64, Vec<String>, Look)>,
    html: String,
    /// The addresses the page's notes link to (`Ask::Link`), and the
    /// folder of the thread it's in, which a relative one is from.
    links: Vec<String>,
    cwd: String,
    /// The ticks are on their way to the runner.
    saving: bool,
    /// A tick changed meanwhile: saved again when that's back.
    again: bool,
    error: Option<String>,
}

#[derive(Default)]
pub(crate) struct ReviewPanes {
    /// By thread.
    open: HashMap<String, Open>,
    opened: u64,
    /// The section the pane was last widened for, and how wide.
    wide: Option<(String, f32)>,
}

/// The ticks a review shows: its draft's while it waits, what was sent after.
fn shown_picks(review: &DesignReview) -> Vec<String> {
    if review.is_pending() {
        review.draft.picked_ids.clone()
    } else {
        review.response.as_ref().map(|r| r.picked_ids.clone()).unwrap_or_default()
    }
}

/// The folder a review's pictures are in, real, for the page's site: the
/// one the runner copied them into, `.../reviews/<review id>`, and nothing
/// else. A review's paths are the runner's word, and a thread moved from
/// another Mac brings that Mac's, so a first picture anywhere else (a
/// folder of Mike's own, say) gets no page rather than a site rooted there
/// (Gemini's review, 20 Nov).
fn folder(review: &DesignReview) -> Option<PathBuf> {
    let first = std::fs::canonicalize(&review.options.first()?.image.path).ok()?;
    // The picture's own folder, or one above it (a page's files are in a
    // folder of their own inside the review's).
    first.ancestors().skip(1).find(|folder| {
        let in_reviews = folder.parent().and_then(Path::file_name).is_some_and(|name| name == "reviews");
        in_reviews && folder.file_name().is_some_and(|name| name.to_str() == Some(review.id.as_str()))
    }).map(Path::to_path_buf)
}

/// A picture's place on the page: its path under the review's folder, with
/// `/` between its parts. None for one that isn't in there.
fn source(folder: &Path, image: &ImageRef) -> Option<String> {
    let real = std::fs::canonicalize(&image.path).ok()?;
    let parts: Option<Vec<&str>> = real.strip_prefix(folder).ok()?.components().map(|part| part.as_os_str().to_str()).collect();
    Some(parts?.join("/"))
}

/// The app's colours, font and text size now, for the page to match.
fn look(cx: &App) -> Look {
    let css = |c: Hsla| {
        let c = Rgba::from(c);
        let part = |v: f32| (v.clamp(0., 1.) * 255.).round() as u8;
        format!("rgba({},{},{},{:.3})", part(c.r), part(c.g), part(c.b), c.a.clamp(0., 1.))
    };
    let system = "-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif";
    let (family, weights): (&str, Vec<u16>) = match style::font_choice() {
        style::Font::Allo => (system, crate::fonts::allo_weights().iter().map(|(weight, _)| *weight).collect()),
        style::Font::System => (system, vec![]),
        style::Font::Serif => ("Charter,Georgia,serif", vec![]),
        style::Font::Mono => ("ui-monospace,Menlo,monospace", vec![]),
    };
    Look {
        dark: cx.theme().is_dark(),
        background: css(cx.theme().background),
        text: css(style::label_text(cx)),
        strong: css(cx.theme().foreground),
        secondary: css(style::secondary_text(cx)),
        hairline: css(style::hairline(cx)),
        fill: css(style::code_background(cx)),
        accent: css(style::control_accent(cx)),
        star: css(style::recommended_star(cx)),
        link: css(style::link_text(cx)),
        font_family: family.to_owned(),
        font_weights: weights,
        size: style::zoomed(style::size::BODY),
        line: style::zoomed(style::size::BODY_LINE),
    }
}

/// The app's own font files, under the names the page asks for them by.
fn fonts(look: &Look) -> Vec<(String, Vec<u8>)> {
    crate::fonts::allo_weights().iter().filter(|(weight, _)| look.font_weights.contains(weight)).map(|(weight, data)| (format!("{}{weight}.otf", rules::FONT_PREFIX), data.to_vec())).collect()
}

/// `reviews.save` for `review` with these ticks, the rest of its draft kept.
fn picks_params(thread_id: &str, review: &DesignReview, picked: &[String]) -> Value {
    let mut draft = review.draft.clone();
    draft.picked_ids = picked.to_vec();
    // Ticks or None, never both.
    if !picked.is_empty() {
        draft.none = false;
    }
    json!({ "threadId": thread_id, "reviewId": review.id, "revision": review.revision, "draft": draft.to_json() })
}

impl SidePane {
    /// Opens `review` as a page over the section in front, for the thread
    /// on show. Returns false for any other thread's: the caller opens the
    /// window, as before.
    pub(crate) fn open_review_page(&mut self, thread_id: &str, review: DesignReview, cx: &mut Context<Self>) -> bool {
        let Some(thread) = self.thread(cx).filter(|t| t.id == thread_id) else { return false };
        self.reviews.opened += 1;
        let key = format!("review:{}:{}:{}", thread.id, review.id, self.reviews.opened);
        let from = match self.previews.get(&thread.id) {
            Some(p) if matches!(p.target, Target::Review(_)) => p.from.clone(),
            _ => self.section_for(&thread),
        };
        let (id, title) = (review.id.clone(), review.title.clone());
        let open = Open { picked: shown_picks(&review), review, key, site: None, made_from: None, html: String::new(), links: vec![], cwd: thread.cwd.clone(), saving: false, again: false, error: None };
        if let Some(old) = self.reviews.open.insert(thread.id.clone(), open) {
            crate::web_panels::close_made_page(&old.key, cx);
        }
        self.show_preview(PanePreview::new(Target::Review(id), title, from), &thread.id, cx);
        self.sync_review_width(cx);
        true
    }

    /// The preview that was a review's page has gone (Back, another file in
    /// its place, the review answered): its view closes, and the pane's
    /// width goes back.
    pub(crate) fn review_closed(&mut self, thread_id: &str, cx: &mut Context<Self>) {
        if let Some(old) = self.reviews.open.remove(thread_id) {
            crate::web_panels::close_made_page(&old.key, cx);
        }
        self.sync_review_width(cx);
    }

    /// The pane as wide as the review on show wants, and back to what it was
    /// when none is: on opening and closing one, and when the thread on show
    /// changes (another thread's pane isn't a review's). All of it once this
    /// update is over: which thread is on show is the app's to say, and the
    /// app may be the one calling (a panel request closing the preview from
    /// inside its own update: Gemini's review, 20 Nov).
    pub(crate) fn sync_review_width(&mut self, cx: &mut Context<Self>) {
        let (side, app) = (cx.entity().downgrade(), self.app.clone());
        cx.defer(move |cx| {
            let (Some(side), Some(app)) = (side.upgrade(), app.upgrade()) else { return };
            let change = side.update(cx, |side, cx| {
                let wanted = side.thread(cx).and_then(|thread| {
                    let preview = side.previews.get(&thread.id)?;
                    let Target::Review(id) = &preview.target else { return None };
                    let open = side.reviews.open.get(&thread.id).filter(|o| &o.review.id == id)?;
                    // At 100% zoom: the app scales it (shell.rs, `show_pane_wide`).
                    Some((preview.from.clone(), rules::pane_width(&open.review)))
                });
                (wanted != side.reviews.wide).then(|| (std::mem::replace(&mut side.reviews.wide, wanted.clone()), wanted))
            });
            let Some((before, wanted)) = change else { return };
            app.update(cx, |app, cx| {
                if let Some((section, _)) = &before {
                    app.restore_pane_width(section, cx);
                }
                if let Some((section, width)) = &wanted {
                    app.show_pane_wide(section, *width, cx);
                }
            });
        });
    }

    /// The ticks a review's page shows now, if it's open here and still
    /// waiting: what the message box sends as the answer (composer.rs), as a
    /// click's tick can be a moment ahead of the runner's copy.
    pub(crate) fn review_ticks(&self, thread_id: &str, review_id: &str) -> Option<Vec<String>> {
        self.reviews.open.get(thread_id).filter(|o| o.review.id == review_id && o.review.is_pending()).map(|o| o.picked.clone())
    }

    /// The runner says a review changed (`review.updated`, whichever thread
    /// is on show): the open page follows it. One that's no longer waiting
    /// (answered from the message box, or put aside by a message) closes, as
    /// there's nothing left to do on it; its card in the thread opens it again.
    /// Called from inside the app's own update, so nothing here reads the
    /// app: the closing waits until that's over.
    pub(crate) fn review_updated(&mut self, thread_id: &str, review: &DesignReview, cx: &mut Context<Self>) {
        let Some(open) = self.reviews.open.get_mut(thread_id).filter(|o| o.review.id == review.id) else { return };
        if review.revision < open.review.revision {
            return;
        }
        let was_pending = open.review.is_pending();
        // Ticks being saved are ahead of this.
        if !open.saving && !open.again {
            open.picked = shown_picks(review);
        }
        open.review = review.clone();
        if was_pending && !review.is_pending() {
            let (side, thread_id, review_id) = (cx.entity().downgrade(), thread_id.to_owned(), review.id.clone());
            cx.defer(move |cx| {
                let Some(side) = side.upgrade() else { return };
                side.update(cx, |side, cx| {
                    if side.previews.get(&thread_id).is_some_and(|p| matches!(&p.target, Target::Review(id) if *id == review_id)) {
                        side.close_preview(&thread_id, cx);
                    }
                });
            });
        }
        cx.notify();
    }

    pub(crate) fn render_review(&mut self, thread: &ThreadSummary, id: &str, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = palette(cx);
        let note = |text: &str| crate::files::pane_note(text, p).into_any_element();
        let now = look(cx);
        let main = self.app.upgrade().is_some_and(|app| app.read(cx).main_window == window.window_handle());
        let Some(open) = self.reviews.open.get_mut(&thread.id).filter(|o| o.review.id == id) else {
            return note("This review isn't open any more. Its card in the thread opens it again.");
        };
        let Some(folder) = folder(&open.review) else { return note("This review's pictures aren't where Threadbear keeps them on this Mac, so its page can't show.") };
        let from = (open.review.revision, open.picked.clone(), now.clone());
        if open.made_from.as_ref() != Some(&from) {
            let made = rules::page(&open.review, &open.picked, &now, &|image| source(&folder, image));
            open.links = made.links;
            // A new look brings its own font files: a site and a view afresh.
            let same_look = open.made_from.as_ref().is_some_and(|(_, _, look)| *look == now);
            match open.site.as_ref().filter(|_| same_look) {
                Some(site) if made.html != open.html => {
                    site.remake(made.html.clone().into_bytes(), &made.assets);
                    // Only its ticks changed (the page as it was, with the
                    // ticks as they were, is what's showing): set on the
                    // page where it stands, so it stays where Mike's
                    // reading. Anything else, and it's loaded again.
                    let before = open.made_from.as_ref().map(|(_, picked, _)| picked.clone()).unwrap_or_default();
                    if rules::page(&open.review, &before, &now, &|image| source(&folder, image)).html == open.html {
                        let changes: Vec<(usize, bool)> = open.review.options.iter().enumerate().filter(|(_, o)| before.contains(&o.id) != open.picked.contains(&o.id)).map(|(index, o)| (index, open.picked.contains(&o.id))).collect();
                        crate::web_panels::run_in_made_page(&open.key, rules::tick_script(&changes), cx);
                    } else {
                        crate::web_panels::reload_made_page(&open.key, cx);
                    }
                }
                Some(_) => {}
                None => {
                    if open.site.is_some() {
                        crate::web_panels::close_made_page(&open.key, cx);
                        open.key.push('+');
                    }
                    open.site = Site::made(&folder, rules::PAGE_NAME, made.html.clone().into_bytes(), &made.assets, fonts(&now)).map(Arc::new);
                }
            }
            open.html = made.html;
            open.made_from = Some(from);
        }
        let Some(site) = open.site.clone() else { return note("This review's folder couldn't be read.") };
        let (key, error) = (open.key.clone(), open.error.clone());
        let side = cx.entity().downgrade();
        let (thread_id, review_id) = (thread.id.clone(), id.to_owned());
        let asked: Rc<dyn Fn(&str, &mut App)> = Rc::new(move |rest: &str, cx: &mut App| {
            let Some(side) = side.upgrade() else { return };
            side.update(cx, |side, cx| side.review_asked(&thread_id, &review_id, rest, cx));
        });
        let page = crate::web_panels::made_page(&key, site, asked, main, window, cx);
        // Why a tick didn't save, over the page.
        let error = error.map(|why| {
            h_flex().flex_none().w_full().px(px(14.)).py(px(8.)).border_b_1().border_color(p.hairline).text_size(px(style::size::DETAIL)).line_height(px(style::natural_line(style::size::DETAIL))).text_color(p.failed).child(why)
        });
        v_flex().id("hl-review").size_full().children(error).child(div().flex_1().min_h_0().child(page)).into_any_element()
    }

    /// A click on one of the page's own links (web_panels::made_page).
    fn review_asked(&mut self, thread_id: &str, review_id: &str, rest: &str, cx: &mut Context<Self>) {
        let Some(open) = self.reviews.open.get(thread_id).filter(|o| o.review.id == review_id) else { return };
        match rules::ask(rest, &open.review, open.links.len()) {
            Some(Ask::Pick(option)) => self.toggle_review_pick(thread_id, option, cx),
            Some(Ask::Open(option, shot)) => {
                let (app, review, thread_id) = (self.app.clone(), open.review.clone(), thread_id.to_owned());
                // Once this update is over: the window's made by the app.
                cx.defer(move |cx| {
                    let Some(app) = app.upgrade() else { return };
                    let main = app.read(cx).main_window;
                    let _ = main.update(cx, |_, window, cx| app.update(cx, |app, cx| app.open_review_window(&thread_id, review, Some((option, shot)), window, cx)));
                });
            }
            Some(Ask::Link(link)) => {
                // From the review's own thread's folder, whichever thread is
                // on show by now.
                let (Some(url), cwd) = (open.links.get(link).cloned(), open.cwd.clone()) else { return };
                crate::open_gate::open_link(&url, Origin::ThisMac, &cwd, cx);
            }
            None => {}
        }
    }

    /// A tick on or off: on the page at once, then saved.
    fn toggle_review_pick(&mut self, thread_id: &str, option: usize, cx: &mut Context<Self>) {
        let Some(open) = self.reviews.open.get_mut(thread_id) else { return };
        let Some(id) = open.review.options.get(option).map(|o| o.id.clone()) else { return };
        self.set_review_pick(thread_id, &id, None, cx);
    }

    /// Ticks or unticks `option` (`on`: None flips it) on the review open
    /// here. In the review's order, as the runner keeps them.
    fn set_review_pick(&mut self, thread_id: &str, option: &str, on: Option<bool>, cx: &mut Context<Self>) {
        let Some(open) = self.reviews.open.get_mut(thread_id) else { return };
        let has = open.picked.iter().any(|p| p == option);
        let want = on.unwrap_or(!has);
        if want == has {
            return;
        }
        open.picked = open.review.options.iter().map(|o| o.id.clone()).filter(|id| if id == option { want } else { open.picked.contains(id) }).collect();
        open.error = None;
        if open.saving {
            open.again = true;
        } else {
            self.save_review_picks(thread_id, cx);
        }
        cx.notify();
    }

    fn save_review_picks(&mut self, thread_id: &str, cx: &mut Context<Self>) {
        let Some(open) = self.reviews.open.get_mut(thread_id) else { return };
        open.saving = true;
        open.again = false;
        let params = picks_params(thread_id, &open.review, &open.picked);
        let (client, thread_id, key, review_id) = (self.client.clone(), thread_id.to_owned(), open.key.clone(), open.review.id.clone());
        cx.spawn(async move |this, cx| {
            let saved = call(client.clone(), "reviews.save", params).await;
            // Turned down (it changed somewhere else, or it's over): the
            // runner's copy, so the page shows what's so.
            let latest = match &saved {
                Ok(_) => None,
                Err(_) => call(client, "reviews.get", json!({ "threadId": thread_id, "reviewId": review_id })).await.ok().and_then(|v| DesignReview::decode(&v["review"])),
            };
            this.update(cx, |this, cx| this.review_picks_saved(&thread_id, &key, saved, latest, cx)).ok();
        })
        .detach();
    }

    fn review_picks_saved(&mut self, thread_id: &str, key: &str, saved: Result<Value, RpcError>, latest: Option<DesignReview>, cx: &mut Context<Self>) {
        let Some(open) = self.reviews.open.get_mut(thread_id).filter(|o| o.key.trim_end_matches('+') == key.trim_end_matches('+')) else { return };
        open.saving = false;
        match saved.map(|v| DesignReview::decode(&v["review"])) {
            Ok(Some(review)) => {
                if review.revision >= open.review.revision {
                    open.review = review;
                }
                if open.again {
                    self.save_review_picks(thread_id, cx);
                }
            }
            Ok(None) => open.error = Some("The runner's answer to that tick didn't make sense.".to_owned()),
            Err(e) => {
                open.again = false;
                open.error = Some(format!("That tick wasn't saved: {}", e.message));
                if let Some(latest) = latest {
                    open.picked = shown_picks(&latest);
                    open.review = latest;
                }
            }
        }
        cx.notify();
    }

    /// The ✕ on a tick over the message box (composer.rs): unticked on the
    /// page if it's open here, else straight on the runner.
    pub(crate) fn untick_review(&mut self, thread_id: &str, review: &DesignReview, option: &str, cx: &mut Context<Self>) {
        if !option.is_empty() && self.reviews.open.get(thread_id).is_some_and(|o| o.review.id == review.id) {
            return self.set_review_pick(thread_id, option, Some(false), cx);
        }
        let picked: Vec<String> = review.draft.picked_ids.iter().filter(|id| id.as_str() != option).cloned().collect();
        let mut params = picks_params(thread_id, review, &picked);
        // "None of them" is the other thing its ✕ takes back.
        if option.is_empty() {
            params["draft"]["none"] = json!(false);
        }
        let (client, app) = (self.client.clone(), self.app.clone());
        cx.spawn(async move |_, cx| {
            if let Err(e) = call(client, "reviews.save", params).await {
                let _ = cx.update(|cx| {
                    if let Some(app) = app.upgrade() {
                        app.update(cx, |app, cx| app.show_error(format!("That tick wasn't taken back: {}", e.message), cx));
                    }
                });
            }
        })
        .detach();
    }

    /// `dump`'s line for a review's page.
    #[cfg(feature = "automation")]
    pub(crate) fn review_dump(&self, thread_id: &str) -> Value {
        match self.reviews.open.get(thread_id) {
            Some(open) => json!({ "review": open.review.id, "status": open.review.status, "picked": open.picked, "saving": open.saving, "error": open.error, "made": open.site.is_some(), "page": open.html, "wide": self.reviews.wide.as_ref().map(|(_, width)| *width) }),
            None => Value::Null,
        }
    }
}

impl crate::thread::ThreadPane {
    /// The review the next message from here answers: the newest one still
    /// waiting with options ticked or None chosen, as the runner has it
    /// (reviewPicksWaiting in runner/src/runner/reviews.ts). Only with the
    /// experiment on, and for this Mac's own threads: another Mac's runner
    /// has its own switch.
    pub(crate) fn review_picks(&self, cx: &App) -> Option<DesignReview> {
        if !is_on(cx) || self.summary.runner_id.is_some() {
            return None;
        }
        self.feed
            .model()
            .rows()
            .iter()
            .filter_map(|row| match &row.content {
                RowContent::Review(review) if review.is_pending() && (!review.draft.picked_ids.is_empty() || review.draft.none) => Some(review),
                _ => None,
            })
            .max_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)))
            .cloned()
    }
}

/// A script's `review-page`: opens the open thread's review (the first, or
/// `id`) the way its card does, which with the experiment on is its page
/// beside the thread; with `ask`, does what a click on that link of the
/// page would ("pick/1", "open/0/0"); and says where the page has got to.
/// `open: false` only reads one that's open.
#[cfg(feature = "automation")]
pub(crate) async fn automation(app: &WeakEntity<crate::app::Threadbear>, main: AnyWindowHandle, cmd: &Value, cx: &mut AsyncApp) -> Result<Value, String> {
    use std::time::Duration;
    let wanted = cmd["id"].as_str().map(str::to_owned);
    let found = app
        .read_with(cx, |t, cx| {
            let thread_id = t.selected.clone()?;
            let pane = t.pane.as_ref()?.read(cx);
            let review = pane
                .feed
                .model()
                .rows()
                .iter()
                .filter_map(|row| match &row.content {
                    RowContent::Review(review) => Some(review.clone()),
                    _ => None,
                })
                .find(|r| wanted.as_ref().is_none_or(|w| &r.id == w))?;
            Some((thread_id, review, t.side.clone()))
        })
        .map_err(|e| e.to_string())?;
    let Some((thread_id, review, side)) = found else { return Err("no review in this thread".into()) };
    let is_open = |cx: &mut AsyncApp| side.read_with(cx, |s, _| s.reviews.open.get(&thread_id).is_some_and(|o| o.review.id == review.id));
    if cmd["open"].as_bool() != Some(false) && !is_open(cx) {
        let app = app.upgrade().ok_or("the app has gone")?;
        cx.update_window(main, |_, window, cx| app.update(cx, |t, cx| t.open_review(&thread_id, review.clone(), window, cx))).map_err(|e| e.to_string())?;
        // It opens once the update that asked is over.
        for _ in 0..100 {
            if is_open(cx) {
                break;
            }
            cx.background_executor().timer(Duration::from_millis(20)).await;
        }
    }
    if !is_open(cx) {
        return Err("that review's page isn't open".into());
    }
    if let Some(ask) = cmd["ask"].as_str() {
        side.update(cx, |s, cx| s.review_asked(&thread_id, &review.id, ask, cx));
        // Until a tick it made is saved.
        for _ in 0..250 {
            if !side.read_with(cx, |s, _| s.reviews.open.get(&thread_id).is_some_and(|o| o.saving || o.again)) {
                break;
            }
            cx.background_executor().timer(Duration::from_millis(20)).await;
        }
    }
    Ok(side.read_with(cx, |s, _| s.review_dump(&thread_id)))
}
