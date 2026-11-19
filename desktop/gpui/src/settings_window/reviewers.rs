// Settings › General › Code review's reviewers (runner/src/lab-reviewers.ts):
// who reviews a thread's code change, in Mike's order, each on its model and
// effort. The first that isn't the thread's own provider and has a login
// with room reviews, so when one runs out for the week the next takes over
// (Mike, 15 Nov 2026, with Codex used up and Grok credits going spare).
// A row's tick puts it on the review panel: for a big or risky change,
// every one ticked with a login reviews at once and their findings merge.
// A provider can be listed more than once on different models, so rows are
// known by their place in the list, not their provider.
//
// The rows drag into order the way the Runners panel's cards do
// (runners_panel.rs). Every change is the whole list, shown at once
// (update_runner_settings guesses, and puts it back if the runner refuses)
// and saved as one `settings.update`.
use super::{row_with, SettingsWindow};
use crate::highlights::{tipped, tipped_as};
use crate::{icons, style};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::{h_flex, ActiveTheme as _, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use crate::style::px;
use serde_json::Value;
use threadbear_core::composer::{effort_title, model_title};
use threadbear_core::logins::{choice_for, ModelChoice, RunnerLogins};
use threadbear_core::runner_settings::{reviewer_dropped, reviewers_change, LabReviewer};

/// A reviewer's row being dragged, by its place in the list.
#[derive(Clone)]
struct DraggedReviewer {
    index: usize,
    provider: String,
    name: SharedString,
}

/// What follows the pointer: the reviewer's mark and name, lifted, as a
/// dragged runner card's ghost is.
struct ReviewerGhost {
    provider: String,
    name: SharedString,
}

impl Render for ReviewerGhost {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (bg, lift, edge) = (cx.theme().background, style::primary_opacity(cx, 0.1), style::hairline(cx));
        h_flex()
            .w(px(220.))
            .px(px(10.))
            .py(px(8.))
            .gap(px(10.))
            .items_center()
            .rounded(px(8.))
            .bg(bg)
            .child(div().absolute().inset_0().rounded(px(8.)).bg(lift).border_1().border_color(edge))
            .shadow_lg()
            .child(icons::provider_mark(&self.provider).with_size(px(14.)).text_color(style::secondary_text(cx)))
            .child(div().text_size(px(12.)).font_weight(FontWeight::MEDIUM).text_color(style::label_text(cx)).child(self.name.clone()))
    }
}

/// The models a provider's logins here offer: the first login of it that
/// lists any (they share a provider's list).
fn models_of(logins: &RunnerLogins, provider: &str) -> Vec<ModelChoice> {
    logins.accounts.iter().filter(|a| a.provider_id() == provider).map(|a| a.models.clone()).find(|m| !m.is_empty()).unwrap_or_default()
}

fn has_login(logins: &RunnerLogins, provider: &str) -> bool {
    logins.accounts.iter().any(|a| a.provider_id() == provider)
}

/// A model's id as a reviewer names it.
fn model_id(m: &ModelChoice) -> String {
    if m.model.is_empty() { m.id.clone() } else { m.model.clone() }
}

/// The rows Add Reviewer offers: one per provider with a login here, in the
/// order the runner lists its providers. One already listed is offered
/// again so it can review on another model too, starting on a model none of
/// its rows has yet (the runner drops an exact repeat, so a second row on
/// the same model would vanish); with every model taken it isn't offered.
fn addable(logins: &RunnerLogins, list: &[LabReviewer]) -> Vec<LabReviewer> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    let ids = logins.providers.iter().map(|p| p.id.clone()).chain(logins.accounts.iter().map(|a| a.provider_id().to_owned()));
    for id in ids {
        if !has_login(logins, &id) || seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());
        let taken: Vec<Option<&str>> = list.iter().filter(|r| r.provider == id).map(|r| r.model.as_deref()).collect();
        if !taken.contains(&None) {
            out.push(LabReviewer::new(&id));
        } else if let Some(free) = models_of(logins, &id).iter().map(model_id).find(|m| !taken.contains(&Some(m.as_str()))) {
            out.push(LabReviewer { model: Some(free), ..LabReviewer::new(&id) });
        }
    }
    out
}

/// The list with one reviewer changed.
fn with(list: &[LabReviewer], i: usize, change: impl FnOnce(&mut LabReviewer)) -> Value {
    let mut out = list.to_vec();
    if let Some(r) = out.get_mut(i) {
        change(r);
    }
    reviewers_change(&out)
}

impl SettingsWindow {
    /// The reviewers' rows, then Add Reviewer when there's a provider with a
    /// login to add.
    pub(super) fn reviewer_rows(&self, list: &[LabReviewer], cx: &mut Context<Self>) -> Vec<AnyElement> {
        let Some(app) = self.app.upgrade() else { return Vec::new() };
        let logins = app.read(cx).logins.clone();
        let mut rows: Vec<AnyElement> = list.iter().enumerate().map(|(i, r)| self.reviewer_row(i, r, list, &logins, cx)).collect();
        let more = addable(&logins, list);
        if !more.is_empty() {
            let choices: Vec<(String, bool, Value)> = more
                .into_iter()
                .map(|r| {
                    let title = logins.provider_title(&r.provider);
                    let mut next = list.to_vec();
                    next.push(r);
                    (title, false, reviewers_change(&next))
                })
                .collect();
            let add = self.menu_owned("settings-reviewer-add".into(), "Add Reviewer".into(), None, "Add a provider you have a login for to the end of the list. One already listed can go on again with another model".into(), choices, cx);
            rows.push(row_with(h_flex().child(add).into_any_element(), div().into_any_element(), cx));
        }
        rows
    }

    fn reviewer_row(&self, i: usize, r: &LabReviewer, list: &[LabReviewer], logins: &RunnerLogins, cx: &mut Context<Self>) -> AnyElement {
        let (secondary, tertiary) = (style::secondary_text(cx), style::tertiary_label(cx));
        let provider = r.provider.clone();
        let name = logins.provider_title(&provider);
        let here = has_login(logins, &provider);
        let movable = list.len() > 1;

        let mut label = h_flex().gap(px(8.)).items_center().min_w_0();
        if movable {
            label = label.child(
                tipped_as(div().id(SharedString::from(format!("settings-reviewer-handle-{i}"))).flex_none().w(px(13.)).h(px(17.)).flex().items_center().justify_center().cursor_grab(), "Drag to change the order", gpui_kit::Role::GenericContainer)
                    .child(icons::symbol("line.3.horizontal").with_size(px(12.)).text_color(tertiary)),
            );
        }
        label = label
            .child(div().flex_none().w(px(18.)).flex().justify_center().child(icons::provider_mark(&provider).with_size(px(14.)).text_color(if here { secondary } else { tertiary })))
            .child(div().min_w_0().whitespace_nowrap().text_ellipsis().overflow_hidden().when(!here, |s| s.text_color(tertiary)).child(name.clone()));
        if !here {
            // Kept in the list (the login may come back), but passed over.
            label = label.child(tipped(div().id(SharedString::from(format!("settings-reviewer-missing-{i}"))).text_size(px(11.)).text_color(tertiary).whitespace_nowrap(), format!("There's no {name} login on this runner, so it's passed over")).child("No login"));
        }

        let models = models_of(logins, &provider);
        let mut controls = h_flex().gap(px(6.)).items_center().flex_none();
        // On the panel or not: a bare tick, its meaning in the tip.
        let me = cx.entity().downgrade();
        let flip = list.to_vec();
        let tip = "On the review panel: for a big or risky change, every reviewer ticked here reviews at once";
        controls = controls.child(Checkbox::new(SharedString::from(format!("settings-reviewer-panel-{i}"))).checked(r.panel).small().tooltip(tip).on_click(move |on: &bool, _, cx| {
            let change = with(&flip, i, |x| x.panel = *on);
            me.update(cx, |this, cx| this.update(change, cx)).ok();
        }));
        if here && !models.is_empty() {
            let shown = r.model.as_deref().map(|m| choice_for(m, &models).map_or_else(|| model_title(Some(m)), |c| if c.title.is_empty() { model_title(Some(m)) } else { c.title.clone() }));
            // A new model keeps the effort only if it offers it; otherwise the
            // row would show a level the review never runs at (Grok's
            // review, 15 Nov 2026), as create drops it (checkSettings).
            let keeps = |model: Option<&str>| r.effort.as_ref().filter(|e| logins.effort_levels(model, &models, &provider).contains(e)).cloned();
            let default_effort = keeps(None);
            let mut choices: Vec<(String, bool, Value)> = vec![("Default".into(), r.model.is_none(), with(list, i, |x| {
                x.model = None;
                x.effort = default_effort;
            }))];
            for m in &models {
                let id = model_id(m);
                let title = if m.title.is_empty() { model_title(Some(&id)) } else { m.title.clone() };
                let picked = r.model.as_deref() == Some(id.as_str()) || r.model.as_deref() == Some(m.id.as_str());
                let effort = keeps(Some(&id));
                choices.push((title, picked, with(list, i, |x| {
                    x.model = Some(id.clone());
                    x.effort = effort;
                })));
            }
            controls = controls.child(self.menu_owned(format!("settings-reviewer-model-{i}"), shown.unwrap_or_else(|| "Default".into()), None, format!("The model {name} reviews on"), choices, cx));
        }
        let levels = logins.effort_levels(r.model.as_deref(), &models, &provider);
        if here && !levels.is_empty() {
            // No effort named is high, as the runner starts it.
            let current = r.effort.clone().unwrap_or_else(|| "high".into());
            let choices: Vec<(String, bool, Value)> = levels
                .iter()
                .map(|l| {
                    let level = l.clone();
                    (effort_title(l), *l == current, with(list, i, |x| x.effort = Some(level)))
                })
                .collect();
            controls = controls.child(self.menu_owned(format!("settings-reviewer-effort-{i}"), effort_title(&current), None, format!("How hard {name} thinks while it reviews"), choices, cx));
        }
        let mut rest = list.to_vec();
        rest.remove(i);
        controls = controls.child(self.icon_button_owned(format!("settings-reviewer-remove-{i}"), "minus.circle", format!("Take {name} off the list"), cx, move |this, _, cx| this.update(reviewers_change(&rest), cx)));

        let row = row_with(label.into_any_element(), controls.into_any_element(), cx);
        let shell = div().id(SharedString::from(format!("settings-reviewer-{i}"))).w_full().rounded(px(8.));
        if !movable {
            return shell.child(row).into_any_element();
        }
        // A drop on a row puts the dragged one in its place; the slot shows
        // dashed meanwhile, as on the Runners panel.
        let slot = style::tertiary_label(cx);
        let order = list.to_vec();
        shell
            .on_drag(DraggedReviewer { index: i, provider: provider.clone(), name: name.into() }, |d, _, _, cx| cx.new(|_| ReviewerGhost { provider: d.provider.clone(), name: d.name.clone() }))
            .drag_over::<DraggedReviewer>(move |s, _, _, _| s.border_1().border_dashed().border_color(slot).m(gpui_kit::px(-1.)))
            .on_drop(cx.listener(move |this, d: &DraggedReviewer, _, cx| {
                if let Some(next) = reviewer_dropped(&order, d.index, i) {
                    this.update(reviewers_change(&next), cx);
                }
            }))
            .child(row)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    // Not super::*: gpui's prelude has a `test` of its own.
    use super::{addable, models_of};
    use serde_json::json;
    use threadbear_core::logins::RunnerLogins;
    use threadbear_core::runner_settings::LabReviewer;

    fn logins() -> RunnerLogins {
        RunnerLogins::from_hello(&json!({
            "accounts": [
                { "id": "claude-main", "provider": "claude" },
                { "id": "codex-main", "provider": "codex", "models": [{ "id": "gpt-6.1-sol" }] },
                { "id": "grok-main", "provider": "grok" },
            ],
            "providers": [{ "id": "claude" }, { "id": "codex" }, { "id": "grok" }, { "id": "cursor" }],
        }))
    }

    #[test]
    fn add_offers_providers_with_a_login_on_a_model_not_listed() {
        let list = vec![LabReviewer::new("codex"), LabReviewer::new("claude")];
        let offered = |list: &[LabReviewer]| addable(&logins(), list).into_iter().map(|r| (r.provider, r.model)).collect::<Vec<_>>();
        assert_eq!(
            offered(&list),
            vec![("codex".into(), Some("gpt-6.1-sol".into())), ("grok".into(), None)],
            "Codex again on its other model; Claude has no other model to go on; Cursor has no login here"
        );
        let both = vec![LabReviewer::new("codex"), LabReviewer { model: Some("gpt-6.1-sol".into()), ..LabReviewer::new("codex") }];
        assert_eq!(offered(&both), vec![("claude".into(), None), ("grok".into(), None)], "every Codex model is taken");
        let picked = vec![LabReviewer { model: Some("gpt-6.1-sol".into()), ..LabReviewer::new("codex") }];
        assert_eq!(offered(&picked)[1], ("codex".into(), None), "the default is free while no Codex row is on it");
        assert_eq!(models_of(&logins(), "codex").len(), 1);
        assert!(models_of(&logins(), "grok").is_empty());
    }
}
