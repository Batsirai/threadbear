// Pictures in the transcript: RowRenderer.imageFrames and ImageLayout. Laid out
// to the reading column's width as the Swift app does, so a grid of mixed
// shapes lines up at one height per row.
use super::metrics::*;
use super::row_wrap;
use crate::style::{MAX_CONTENT_WIDTH, SIDE_INSET};
use crate::thread::ThreadPane;
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::prelude::*;
use gpui_kit::*;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::style::px;
use crate::tips::Tip as _;
use threadbear_core::reducer::{ImageRef, Row};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Frame {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// `ImageLayout.frames`: each image fits within `cell_width` by `max_height`,
/// never scaled up. Images sharing a row are brought to that row's shortest
/// height, keeping their shapes, so their tops and bottoms line up.
pub(crate) fn image_frames(
    sizes: &[(f32, f32)],
    max_width: f32,
    max_height: f32,
    cell_width: f32,
    gap: f32,
    align_right: bool,
) -> (Vec<Frame>, f32) {
    const MIN_SIDE: f32 = 24.;
    if sizes.is_empty() {
        return (vec![], 0.);
    }
    let cell_width = max_width.min(cell_width);
    let fitted: Vec<(f32, f32)> = sizes
        .iter()
        .map(|&(w, h)| {
            let scale = 1f32.min(max_height / h.max(1.)).min(cell_width / w.max(1.));
            (
                MIN_SIDE.max((w * scale).floor()),
                MIN_SIDE.max((h * scale).floor()),
            )
        })
        .collect();
    // Rows of indices, filled left to right.
    let mut rows: Vec<Vec<usize>> = vec![];
    let mut x = 0.;
    for (index, &(w, _)) in fitted.iter().enumerate() {
        match rows.last_mut() {
            Some(row) if !(x > 0. && x + w > max_width) => row.push(index),
            _ => {
                rows.push(vec![index]);
                x = 0.;
            }
        }
        x += w + gap;
    }
    let mut frames = vec![
        Frame {
            x: 0.,
            y: 0.,
            w: 0.,
            h: 0.
        };
        sizes.len()
    ];
    let mut y = 0.;
    for row in &rows {
        let height = if row.len() > 1 {
            row.iter().map(|&i| fitted[i].1).fold(f32::MAX, f32::min)
        } else {
            fitted[row[0]].1
        };
        let mut x = 0.;
        for &index in row {
            let (w, h) = fitted[index];
            let width = if row.len() > 1 && h > height {
                MIN_SIDE.max((w * height / h).floor())
            } else {
                w
            };
            frames[index] = Frame {
                x,
                y,
                w: width,
                h: height,
            };
            x += width + gap;
        }
        if align_right {
            if let Some(&last) = row.last() {
                let shift = max_width - (frames[last].x + frames[last].w);
                for &index in row {
                    frames[index].x += shift;
                }
            }
        }
        y += height + gap;
    }
    (frames, y - gap)
}

/// An image's size in pixels, or the Swift app's stand-in while it's unknown.
pub(crate) fn pixel_size(image: &ImageRef) -> (f32, f32) {
    match (image.width, image.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => (w as f32, h as f32),
        _ => (160., 120.),
    }
}

/// Where a grid's pictures come from: this Mac's files, or another Mac's
/// runner (`runner`), asked through `client`, `redraw` told when one comes.
pub(crate) struct TilesFrom {
    pub(crate) runner: Option<String>,
    pub(crate) runner_name: String,
    pub(crate) client: std::sync::Arc<threadbear_client::runner::Client>,
    pub(crate) redraw: AnyWeakEntity,
}

/// A message's or a tool's pictures as tiles at `frames`: a click opens the
/// in-app viewer, this Mac's drag out as files, and another Mac's are asked
/// of its runner and say so quietly while they come (the transcript's, and
/// a Feed card's, inbox_feed.rs).
pub(crate) fn picture_grid(
    images: &[ImageRef],
    frames: Vec<Frame>,
    height: f32,
    width: f32,
    from: &TilesFrom,
    cx: &mut App,
) -> Div {
    use crate::file_drag::FileDragExt as _;
    let file_name = |path: &str| {
        std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    };
    let mut grid = div().relative().h(px(height)).w(px(width)).flex_none();
    let all: Vec<ImageRef> = images.to_vec();
    // Another Mac's thread: its pictures are asked of the runner (remote_pictures.rs).
    let remote = from.runner.clone();
    let runner_name = from.runner_name.clone();
    for (i, (image, frame)) in images.iter().zip(frames).enumerate() {
        let path = image.path.clone();
        // Its file's name, for VoiceOver and for scripts.
        let label = SharedString::from(file_name(&path));
        let tile_images = all.clone();
        let tile = div()
            .id(("image", i))
            .absolute()
            .left(px(frame.x))
            .top(px(frame.y))
            .w(px(frame.w))
            .h(px(frame.h))
            .rounded(px(8.))
            .overflow_hidden();
        let Some(runner) = remote.clone() else {
            grid = grid.child(
                tile.cursor_pointer()
                    .tip(crate::viewer::TILE_TIP)
                    // The in-app viewer, not the file's default app: only a
                    // real picture opens, and nothing is ever run (viewer.rs).
                    .on_click(move |_, window, cx| {
                        crate::viewer::open_from_tile(&tile_images, i, None, window, cx)
                    })
                    // Dragged, it goes out as the file itself (file_drag.rs).
                    .file_drag(Some(path.clone()))
                    .child(
                        img(super::markdown::file_picture(&path))
                            .w(px(frame.w))
                            .h(px(frame.h))
                            .rounded(px(8.))
                            .object_fit(ObjectFit::Cover),
                    )
                    .test_support()
                    .role(Role::Image)
                    .aria_label(label),
            );
            continue;
        };
        let picture =
            crate::remote_pictures::picture(&runner, &path, &from.client, from.redraw.clone(), cx);
        let words = crate::remote_pictures::words(&picture, &runner_name);
        let tile = match picture {
            // In the viewer on a click, as this Mac's are, from the bytes
            // that Mac sent (Mike, 18 Nov). No drag: it isn't a file here.
            crate::remote_pictures::Picture::Ready(bytes) => {
                let runner = runner.clone();
                tile.cursor_pointer()
                    .tip(crate::viewer::TILE_TIP)
                    .on_click(move |_, window, cx| {
                        crate::viewer::open_from_tile(&tile_images, i, Some(&runner), window, cx)
                    })
                    .child(
                        img(bytes)
                            .w(px(frame.w))
                            .h(px(frame.h))
                            .rounded(px(8.))
                            .object_fit(ObjectFit::Cover),
                    )
            }
            // Why it couldn't be got, on hover; a click asks again.
            crate::remote_pictures::Picture::Failed(why) => {
                let me = from.redraw.clone();
                tile.cursor_pointer().tip(why).on_click(move |_, _, cx| {
                    crate::remote_pictures::retry(&runner, &path, cx);
                    if let Some(me) = me.upgrade() {
                        cx.notify(me.entity_id());
                    }
                })
            }
            _ => tile,
        };
        let (fill, faint) = (
            crate::style::code_background(cx),
            crate::style::faint_text(cx),
        );
        grid = grid.child(
            tile.when_some(words, |s, words| {
                s.bg(fill)
                    .border(gpui_kit::px(0.5))
                    .border_color(crate::style::card_border(cx))
                    .flex()
                    .items_center()
                    .justify_center()
                    .px(px(4.))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_size(px(crate::style::size::WORK - 1.))
                            .text_color(faint)
                            .child(words),
                    )
            })
            .test_support()
            .role(Role::Image)
            .aria_label(label),
        );
    }
    grid
}

impl ThreadPane {
    /// The reading column's width, from the list's last layout (`render` keeps
    /// it, as the list can't be asked while it lays its rows out).
    fn column_width(&self) -> f32 {
        if self.rows.list_width <= 0. {
            return MAX_CONTENT_WIDTH;
        }
        (self.rows.list_width - SIDE_INSET * 2.).clamp(200., MAX_CONTENT_WIDTH)
    }

    fn image_grid(
        &self,
        images: &[ImageRef],
        frames: Vec<Frame>,
        height: f32,
        width: f32,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let runner = self.summary.runner_id.clone();
        let runner_name = runner
            .as_deref()
            .and_then(|id| {
                self.composer
                    .read(cx)
                    .app
                    .upgrade()
                    .map(|app| app.read(cx).runner_name_of(id))
            })
            .unwrap_or_default();
        let from = TilesFrom {
            runner,
            runner_name,
            client: self.client_handle(),
            redraw: cx.entity().downgrade().into(),
        };
        picture_grid(images, frames, height, width, &from, cx)
    }

    /// A tool's pictures under its row: screenshots stay thumbnails, a
    /// picture the agent made is the point of the step, so it's shown large.
    pub(crate) fn images_row(
        &self,
        row: &Row,
        images: &[ImageRef],
        generated: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let width = self.column_width() - if row.in_group { GROUP_INDENT } else { 0. };
        let sizes: Vec<_> = images.iter().map(pixel_size).collect();
        let (frames, height) = if generated {
            image_frames(
                &sizes,
                width,
                GENERATED_MAX_SIDE,
                GENERATED_MAX_SIDE,
                IMAGE_GAP,
                false,
            )
        } else {
            image_frames(
                &sizes,
                width,
                GRID_MAX_HEIGHT,
                GRID_MAX_WIDTH,
                IMAGE_GAP,
                false,
            )
        };
        row_wrap(
            row,
            div()
                .pt(px(ROW_TOP + 2.))
                .pb(px(ROW_BOTTOM))
                .child(self.image_grid(images, frames, height, width, cx)),
        )
    }

    /// Attachments sit above the bubble, right-aligned, with no box.
    pub(crate) fn user_images(
        &self,
        images: &[ImageRef],
        ix: usize,
        phone: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let width = (self.column_width() * BUBBLE_SHARE).floor();
        let sizes: Vec<_> = images.iter().map(pixel_size).collect();
        let (frames, height) = image_frames(
            &sizes,
            width,
            USER_THUMB_HEIGHT,
            GRID_MAX_WIDTH,
            IMAGE_GAP,
            true,
        );
        let left = frames.iter().map(|f| f.x).fold(width, f32::min);
        div()
            .relative()
            .mb(px(IMAGE_GAP))
            .child(self.image_grid(images, frames, height, width, cx))
            .when(phone, |d| {
                d.child(
                    div()
                        .absolute()
                        .left(px(left - 24.))
                        .top(px(height - 26.))
                        .child(super::phone::mark(ix, cx)),
                )
            })
            .into_any_element()
    }
}
