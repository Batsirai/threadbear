#![cfg(feature = "automation")]

// A GIF in the side pane, the picture viewer or the review stage plays while
// the window isn't the key one. Upstream GPUI stepped an `img`'s frames only
// in the active window, so a GIF filmed on Tinker Desk (its window shown but
// not key) or beside another app stayed on its first frame (20 Nov 2026,
// after d7934b5c4 gave those pictures their ids). The vendored img.rs drops
// that check; this keeps it dropped.

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    img, Context, Image, ImageFormat, ImageSource, InteractiveElement as _, IntoElement, Render,
    Styled as _, TestAppContext, VisualTestContext, Window,
};
use std::sync::Arc;

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

/// Draws the picture with its window not the key one, and says how many
/// next-frame callbacks the draw asked for.
fn frames_asked_for(picture: Arc<Image>) -> usize {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(move |_, _| Picture(picture));
    let mut cx = VisualTestContext::from_window(window.into(), &cx);
    // The first draw starts the decode; the next has the frames.
    cx.update(|window, cx| window.render_frame(cx));
    cx.run_until_parked();
    cx.deactivate_window();
    cx.update(|window, cx| {
        assert!(!window.is_window_active());
        window.simulate_next_frame(cx);
        window.render_frame(cx);
        window.simulate_next_frame(cx)
    })
}

#[test]
fn a_gif_keeps_playing_when_its_window_is_not_the_key_one() {
    assert!(
        frames_asked_for(picture(3)) > 0,
        "a GIF in a window that isn't the key one asked for no next frame, so it stays on its first"
    );
}

#[test]
fn a_still_picture_asks_for_no_frames() {
    assert_eq!(frames_asked_for(picture(1)), 0);
}
