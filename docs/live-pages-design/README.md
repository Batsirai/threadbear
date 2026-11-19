# Live pages

Mike, 19 Nov 2026, from his phone while a thread showed him still renders of
his garden's 3D model with the Christmas light strings drawn on: "render 3D
objects like the one that you just showed me inside of Threadbear, both on
the mobile and on desktop, or render HTML inside iframes ... so I can kind of
like see it in real time, in line".

Three directions were mocked with a real three.js garden running inside
(thread ae88bd2c, review d3fda522): A, live pages (agent HTML with scripts,
sealed); B, a scene card (the app's own 3D viewer, data only); C, pinning a
dev server's URL. **Mike picked A.** B and C were passed over.

The prototype page is `~/dev/me/misc/live-3d-proto` (`build.py` makes
`out/garden-live.html`: one 5.5 MB file with three.js, the Draco decoder,
`garden04.glb` and 1,764 LED positions inline, no network).

## What it is

An agent writes a page as one self-contained `.html` file and puts it in its
reply as `![Garden lights](/path/garden.html)`, the way it shows a picture or
a video today, or pins it. Every surface shows it in the transcript as a
card: a still of the page with Run. Run turns its scripts on, there in the
card, still sealed. The full size button opens it big (a window on the Mac,
full screen on the phone).

- One file: what's inline is all it gets. Nothing beside it is served (the
  side pane's named assets stay a side pane thing), so it looks the same on
  the Mac, the phone and the web, which only ever get the one file.
- At most 10 MB, the reply media limit.
- Behind the `livePages` experiment, on for Mike.

## Sealed

What a running page can't do, on every surface:

- reach the network (no fetch, socket, WebRTC, prefetch, navigation, form,
  window, download);
- read anything but its own bytes (no files beside it, no other page's
  storage: a fresh opaque origin or a token origin per card, no persistent
  storage);
- leave its box (no top navigation, no popups, no dialogs, clipboard writes
  only through the existing guards);
- run while it isn't wanted: only after Run (per device, for those exact
  bytes, by digest), only while on screen, one running card at a time per
  window; scrolled away it pauses.

Run per page is the consent and the battery saver both. What's left once
it runs: it uses CPU and GPU while visible, and it can draw anything,
including something that looks like Threadbear asking for a password. With
no network, nothing typed into it can leave.

The upload: an agent could name any file with `.html` on the end, so the
runner sends only a file that looks like HTML (UTF-8, markup in its first
bytes), as reply pictures are checked to be pictures. Storage keeps it as
`application/octet-stream`, never `text/html`, so its URL opened in a
browser downloads rather than running on the backend's origin; the apps
fetch the bytes and load them into their sealed views.

## Each surface

| | Still | Running |
|---|---|---|
| Mac (GPUI) | the offscreen Chromium that pictures html blocks today | the same offscreen page at 30 fps, its frames drawn in the card, the pointer and scroll passed in |
| iPhone | WKWebView with scripts off (RichWebSandbox) | the same with scripts on |
| Android | WebView, scripts off, blocking network loads | scripts on |
| Website | iframe, `sandbox=""` | `sandbox="allow-scripts"`, CSP `default-src 'none'` with inline and data: |

## Slices

1. Runner and backend (built, API 95): `.html` reply media goes up as a
   page, checked to be markup, stored as plain bytes, with `mediaType` on
   the phone's pictures. No new request, so no parity row; the phones and
   website show a page as the picture they can't load until their slices.
2. Mac: the card, Run, running inline, full size.
3. iPhone.
4. Website and Android.
5. Telling agents: the guide, and a line in what agents read about showing
   things (within the context budget).
