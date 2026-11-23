// The quiet inbox for Mike's own threads (experiment quietInboxMine;
// docs/protocol/threads.md, "Inbox guess"): the runner archives a finished
// thread of his when a model judges he didn't need to see it. He picked
// "Count and list" for checking what it hid (23 Nov 2026): one small line at
// the foot of the Inbox, "Quietly archived: 6 today", that opens the list of
// them under it, newest first. Each row opens its thread, as any archived
// one does, and its button, "Should have shown me", brings it back to the
// inbox at once and tells the runner the guess was wrong (`threads.update`
// with `archived: false, verdict: "shouldHaveShown"`), rolled back with the
// error if the runner refuses (`update_thread`).
use crate::app::Threadbear;
use crate::sidebar::metrics::{CORNER, LEADING, TRAILING};
use crate::sidebar::{icon, icon_button, tipped, Palette};
use crate::style;
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::h_flex;
use gpui_kit::prelude::*;
use gpui_kit::*;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::style::px;
use serde_json::json;
use threadbear_core::sidebar as rows;

type Clock = threadbear_core::chrono::DateTime<threadbear_core::chrono::Local>;

impl Threadbear {
    /// Today's quietly archived threads, newest first: (id, title, why).
    pub(crate) fn quiet_today(&self, clock: &Clock) -> Vec<(String, String, String)> {
        rows::quiet_today(self.threads.values().map(|t| &**t), clock)
            .into_iter()
            .map(|t| {
                let why = t
                    .quietly_archived
                    .as_ref()
                    .map(|q| q.why.clone())
                    .unwrap_or_default();
                (t.id.clone(), t.title.clone(), why)
            })
            .collect()
    }

    /// "Should have shown me": back to the inbox now, the label with it.
    pub(crate) fn should_have_shown(&mut self, id: &str, cx: &mut Context<Self>) {
        self.update_thread(
            id,
            |t| {
                t.archived_at = None;
                t.quietly_archived = None;
            },
            json!({ "archived": false, "verdict": "shouldHaveShown" }),
            cx,
        );
    }

    /// The line, and the list under it while it's open: each with the key
    /// the list's motion knows it by. Nothing on a day none were hidden.
    pub(crate) fn render_quiet(
        &mut self,
        clock: &Clock,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> Vec<(String, AnyElement)> {
        let hidden = self.quiet_today(clock);
        if hidden.is_empty() {
            self.sidebar.quiet_open = false;
            return vec![];
        }
        let open = self.sidebar.quiet_open;
        let (line, tip) = rows::quiet_line(hidden.len(), open);
        let (hover, secondary) = (p.hover, p.secondary);
        let chevron = if open {
            "chevron.down"
        } else {
            "chevron.right"
        };
        let head = tipped!(
            h_flex()
                .mt(px(6.))
                .gap(px(6.))
                .pl(px(LEADING))
                .pr(px(TRAILING))
                .py(px(5.))
                .rounded(px(CORNER))
                .hover(move |s| s.bg(hover))
                .text_size(px(style::size::SIDEBAR_PREVIEW))
                .text_color(secondary),
            "quiet-inbox-line",
            tip
        )
        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
            this.sidebar.quiet_open = !this.sidebar.quiet_open;
            this.notify_threads_panel(cx);
            cx.notify();
        }))
        .child(line)
        .child(icon(chevron, style::size::SIDEBAR_PREVIEW - 2., secondary))
        .into_any_element();
        let mut out = vec![("quiet:line".to_owned(), head)];
        if open {
            for (id, title, why) in hidden {
                let row = self.render_quiet_row(id.clone(), title, why, p, cx);
                out.push((format!("quiet:{id}"), row));
            }
        }
        out
    }

    fn render_quiet_row(
        &mut self,
        id: String,
        title: String,
        why: String,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (hover, fg, selected) = (p.hover, p.fg, p.selected);
        let is_open = self.selected.as_deref() == Some(id.as_str());
        let row_tip = if why.is_empty() {
            "Open this thread".to_owned()
        } else {
            format!("Why it was hidden: {why}")
        };
        let open_id = id.clone();
        let back_id = id.clone();
        let listener =
            cx.listener(move |this, _: &ClickEvent, _, cx| this.should_have_shown(&back_id, cx));
        let button = icon_button(
            ElementId::Name(format!("quiet-back:{id}").into()),
            icon("tray.and.arrow.up", 13., p.secondary),
            rows::should_have_shown_tip(&title),
            p,
            listener,
        );
        tipped!(
            h_flex()
                .gap(px(6.))
                .pl(px(LEADING + 12.))
                .pr(px(TRAILING - 4.))
                .py(px(3.))
                .rounded(px(CORNER))
                .when(is_open, move |s| s.bg(selected))
                .hover(move |s| s.bg(hover)),
            ElementId::Name(format!("quiet-row:{id}").into()),
            row_tip
        )
        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
            this.open(open_id.clone(), window, cx);
        }))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(style::size::SIDEBAR_PREVIEW))
                .text_color(fg)
                .child(title),
        )
        .child(button)
        .into_any_element()
    }
}
