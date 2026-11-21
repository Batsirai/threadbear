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
// drawing at every display frame. These run on the executor's clock, which
// img.rs reads too; the frames' different delays show which one is up.

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    img, Context, Image, ImageFormat, ImageSource, InteractiveElement as _, IntoElement, Render,
    Styled as _, TestAppContext, VisualTestContext, Window,
};
use std::{cell::RefCell, rc::Rc, sync::Arc, time::Duration};

/// A GIF whose frames show for these many milliseconds (multiples of 10).
fn gif(delays: &[u32]) -> Arc<Image> {
    use image::codecs::gif::{GifEncoder, Repeat};
    use image::{Delay, Frame, ImageBuffer, Rgba};
    let mut bytes = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut bytes);
        encoder.set_repeat(Repeat::Infinite).unwrap();
        for (n, ms) in delays.iter().enumerate() {
            let shade = (n * 80) as u8;
            let frame = Frame::from_parts(
                ImageBuffer::from_pixel(4, 4, Rgba([shade, 0, 0, 255])),
                0,
                0,
                Delay::from_numer_denom_ms(*ms, 1),
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

/// Draws the picture with its window not the key one. If `gap` is given, the
/// clock then moves that far with nothing drawn (the window hidden) and it's
/// drawn once more. Then it runs for `run` in 10 ms steps, drawing whenever
/// it's woken, and says how many milliseconds after the last draw before the
/// run each wake came.
fn wakes(picture: Arc<Image>, gap: Option<Duration>, run: Duration) -> Vec<u128> {
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
        cx.executor().advance_clock(gap);
        cx.update(|window, cx| window.render_frame(cx));
    }
    let start = cx.executor().now();
    let woken = Rc::new(RefCell::new(Vec::new()));
    let _watch = cx.update({
        let woken = woken.clone();
        |_, cx| {
            cx.observe(&view, move |_, cx| {
                let at = cx.background_executor().now() - start;
                woken.borrow_mut().push(at.as_millis());
            })
        }
    });
    let step = Duration::from_millis(10);
    let mut seen = 0;
    for _ in 0..run.as_millis() / step.as_millis() {
        cx.executor().advance_clock(step);
        cx.run_until_parked();
        if woken.borrow().len() > seen {
            seen = woken.borrow().len();
            cx.update(|window, cx| window.render_frame(cx));
        }
    }
    woken.take()
}

#[test]
fn a_gif_steps_through_its_frames_when_its_window_is_not_the_key_one() {
    // Frames of 50, 200 and 50 ms: woken as each is due, round and round.
    // Stuck on its first frame, it would be woken every 50 ms, or not at all.
    assert_eq!(
        wakes(gif(&[50, 200, 50]), None, Duration::from_millis(700)),
        vec![50, 250, 300, 350, 550, 600, 650]
    );
}

#[test]
fn a_frame_of_no_time_shows_for_a_tenth_of_a_second() {
    assert_eq!(
        wakes(gif(&[0, 0]), None, Duration::from_millis(350)),
        vec![100, 200, 300]
    );
}

#[test]
fn a_gif_drawn_after_a_long_gap_starts_its_clock_again() {
    // Hidden for 300 ms (six frames), it steps once and shows that frame its
    // whole 50 ms, rather than racing through the ones it missed.
    assert_eq!(
        wakes(
            gif(&[50, 50, 50]),
            Some(Duration::from_millis(300)),
            Duration::from_millis(120)
        ),
        vec![50, 100]
    );
}

#[test]
fn a_still_picture_is_never_woken() {
    assert_eq!(
        wakes(gif(&[50]), None, Duration::from_secs(1)),
        Vec::<u128>::new()
    );
}
