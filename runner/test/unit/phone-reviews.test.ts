import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { draftFromPhone, phoneReview, reviewImageSource, reviewStills } from '../../src/phone-reviews.ts';
import type { DesignReview } from '../../src/protocol.ts';
import { makePng } from '../helpers/png.ts';

const review: DesignReview = {
  id: 'review-id', title: 'Pick a layout', recommended: 'A', status: 'pending', revision: 0,
  createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z', draft: { notes: {} },
  options: [{ id: 'A', title: 'First', image: { path: '/private/first.png', mediaType: 'image/png' }, url: 'http://localhost:3000/private',
    shots: [{ title: 'Overview', image: { path: '/private/first.png', mediaType: 'image/png' }, media: { path: '/private/page.html', mediaType: 'text/html' } }] },
  { id: 'B', title: 'Today', reference: true, image: { path: '/private/ref.png', mediaType: 'image/png' } }],
};

test('phone reviews keep choices and labels without exposing local paths or HTML', () => {
  const dto = phoneReview(review);
  assert.equal(dto.recommended, 'A');
  assert.equal(dto.options[1].reference, true);
  assert.equal(dto.options[0].shots[0].kind, 'page');
  assert.equal(dto.options[0].shots[0].title, 'Overview');
  assert.ok(!JSON.stringify(dto).includes('/private'));
  assert.deepEqual(dto.draft, { notes: {} });
});

test("a draft's pasted pictures, which are paths on the Mac, never reach the phone", () => {
  const withImages: DesignReview = {
    ...review,
    draft: { pickedIds: ['A'], notes: { A: 'Tighter' }, reply: 'Go', images: [{ path: '/Users/me/Library/Application Support/Threadbear/threads/t/media/reviews/r/reply/abc.png', mediaType: 'image/png' }] },
  };
  const dto = phoneReview(withImages);
  assert.deepEqual(dto.draft, { pickedIds: ['A'], notes: { A: 'Tighter' }, reply: 'Go' });
  assert.ok(!JSON.stringify(dto).includes('/Users/'), JSON.stringify(dto));
  // An answered review shows its response, which is cleaned the same way.
  const answered = phoneReview({ ...withImages, status: 'answered', response: withImages.draft });
  assert.ok(!JSON.stringify(answered).includes('/Users/'));
  assert.ok(!('images' in answered.draft));
});

test("the phone's answer is rebuilt field by field, notes from a list", () => {
  const draft = draftFromPhone({ pickedIds: ['A'], notes: [{ id: '$odd', text: 'one' }, { id: 'Café', text: 'two' }, { id: '__proto__', text: 'three' }], reply: 'Go', images: [{ path: '/etc/passwd' }] });
  assert.deepEqual(Object.keys(draft.notes), ['$odd', 'Café', '__proto__']);
  assert.equal(draft.notes['__proto__'], 'three');
  assert.equal(draft.reply, 'Go');
  assert.ok(!('images' in draft), 'pictures from the phone are never taken: they would name files on this Mac');
  assert.throws(() => draftFromPhone({ notes: { A: 'object' } }));
  assert.throws(() => draftFromPhone({ notes: [], pickedIds: [1] }));
});

test("a review's stills: only files in its own folder, not links, each once", async () => {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-reviews-'));
  try {
    const dir = path.join(media, 'reviews', review.id);
    fs.mkdirSync(dir, { recursive: true });
    const good = path.join(dir, 'a.png');
    fs.writeFileSync(good, makePng(40, 30));
    const junk = path.join(dir, 'b.png');
    fs.writeFileSync(junk, 'not a picture at all');
    // A picture elsewhere on the Mac, named outright and through a link.
    const elsewhere = path.join(media, 'private.png');
    fs.writeFileSync(elsewhere, makePng(10, 10));
    const link = path.join(dir, 'link.png');
    fs.symlinkSync(elsewhere, link);
    const still = (p: string) => ({ path: p, mediaType: 'image/png' });
    const r: DesignReview = { ...review, options: [
      { id: 'A', title: 'A', image: still(good), shots: [{ image: still(good) }, { image: still(good), title: 'again' }] },
      { id: 'B', title: 'B', image: still(junk) },
      { id: 'C', title: 'C', image: still(path.join(dir, 'gone.png')) },
      { id: 'D', title: 'D', image: still(elsewhere) },
      { id: 'E', title: 'E', image: still(link) },
    ] };
    const { stills, noPreview } = await reviewStills(r, media);
    assert.deepEqual(stills, [{ src: reviewImageSource(r.id, good), read: good, within: dir }], 'the same still goes once');
    assert.deepEqual([...noPreview].sort(), [junk, path.join(dir, 'gone.png'), elsewhere, link].map((p) => reviewImageSource(r.id, p)).sort());
    const dto = phoneReview(r, noPreview);
    assert.equal(dto.options[0].shots[0].preview, undefined);
    assert.ok(dto.options.slice(1).every((o) => o.shots[0].preview === false));
    // A review id that would lead out of the folder sends nothing.
    assert.equal((await reviewStills({ ...r, id: '../x' }, media)).stills.length, 0);
  } finally {
    fs.rmSync(media, { recursive: true, force: true });
  }
});
