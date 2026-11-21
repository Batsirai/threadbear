#![cfg(feature = "automation")]
#![expect(
    clippy::unwrap_used,
    reason = "test helpers: a failure there is the test failing"
)]

// A GIF in the side pane, the picture viewer or the review stage plays while
// the window isn't the key one. Upstream GPUI stepped an `img`'s frames only
// in the active window, so a GIF filmed on Tinker Desk (its window shown but
// not key) or beside another app stayed on its first frame (20 Nov 2026,
// after d7934b5c4 gave those pictures their ids). The vendored img.rs drops
// that check, and wakes the view when the next frame is due rather than
// drawing at every display frame; this keeps both.

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    img, Context, Image, ImageFormat, ImageSource, InteractiveElement as _, IntoElement, Render,
    Styled as _, TestAppContext, VisualTestContext, Window,
};
use std::{cell::Cell, rc::Rc, sync::Arc, time::Duration};

fn picture(frames: u32) -> Arc<Image> {
    use image::codecs::gif::{GifEncoder, Repeat};
    use image::{Delay, Frame, ImageBuffer, Rgba};
    let mut bytes = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut bytes);
        encoder.set_repeat(Repeat::Infinite).unwrap();
        for n in 0..frames {
            let shade = (n * 80) as u8;
            let frame = Frame::from_parts(
                ImageBuffer::from_pixel(4, 4, Rgba([shade, 0, 0, 255])),
                0,
                0,
                Delay::from_numer_denom_ms(50, 1),
            );
            encoder.encode_frame(frame).unwrap();
        }
    }
    Arc::new(Image::from_bytes(ImageFormat::Gif, bytes))
}

/// The picture under an id, as files.rs, viewer.rs and stage.rs draw it.
struct Picture(Arc<Image>);

impl Render for Picture {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        img(ImageSource::Image(self.0.clone()))
            .id("hl-picture-test")
            .size_full()
    }
}

/// Draws the picture with its window not the key one (and again after a real
/// `gap`, when given), then lets `wait` go by, and says how many times the
/// picture's view was woken to draw its next frame.
fn wakes_after(picture: Arc<Image>, gap: Option<Duration>, wait: Duration) -> usize {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(move |_, _| Picture(picture));
    let view = window.update(&mut cx, |_, _, cx| cx.entity()).unwrap();
    let mut cx = VisualTestContext::from_window(window.into(), &cx);
    // The first draw starts the decode; the next has the frames.
    cx.update(|window, cx| window.render_frame(cx));
    cx.run_until_parked();
    cx.deactivate_window();
    cx.update(|window, cx| {
        assert!(!window.is_window_active());
        window.render_frame(cx);
    });
    if let Some(gap) = gap {
        std::thread::sleep(gap);
        cx.update(|window, cx| window.render_frame(cx));
    }
    let wakes = Rc::new(Cell::new(0));
    let _watch = cx.update({
        let wakes = wakes.clone();
        |_, cx| cx.observe(&view, move |_, _| wakes.set(wakes.get() + 1))
    });
    cx.executor().advance_clock(wait);
    cx.run_until_parked();
    wakes.get()
}

#[test]
fn a_gif_keeps_playing_when_its_window_is_not_the_key_one() {
    assert!(
        wakes_after(picture(3), None, Duration::from_millis(60)) > 0,
        "a GIF in a window that isn't the key one wasn't woken for its next frame, so it stays on its first"
    );
}

#[test]
fn a_gif_is_woken_at_its_own_pace_not_every_display_frame() {
    // Its frames show for 50 ms: nothing wakes it before then.
    assert_eq!(wakes_after(picture(3), None, Duration::from_millis(30)), 0);
}

#[test]
fn a_still_picture_is_never_woken() {
    assert_eq!(wakes_after(picture(1), None, Duration::from_secs(1)), 0);
}

#[test]
fn a_gif_drawn_after_a_long_gap_starts_its_clock_again() {
    // Hidden for a while (here 300 ms, six frames), it steps once and shows
    // that frame its full 50 ms, rather than racing through the ones it
    // missed at every draw.
    assert_eq!(
        wakes_after(
            picture(3),
            Some(Duration::from_millis(300)),
            Duration::from_millis(30)
        ),
        0
    );
}
