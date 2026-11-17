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

test("a review's stills: ready ones by their own path, and ones that can't go marked", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-reviews-'));
  try {
    const good = path.join(dir, 'a.png');
    fs.writeFileSync(good, makePng(40, 30));
    const junk = path.join(dir, 'b.png');
    fs.writeFileSync(junk, 'not a picture at all');
    const r: DesignReview = { ...review, options: [
      { id: 'A', title: 'A', image: { path: good, mediaType: 'image/png' }, shots: [{ image: { path: good, mediaType: 'image/png' } }, { image: { path: good, mediaType: 'image/png' }, title: 'again' }] },
      { id: 'B', title: 'B', image: { path: junk, mediaType: 'image/png' } },
      { id: 'C', title: 'C', image: { path: path.join(dir, 'gone.png'), mediaType: 'image/png' } },
    ] };
    const { stills, noPreview } = await reviewStills(r);
    assert.deepEqual(stills, [{ path: good, src: reviewImageSource(r.id, good) }], 'the same still goes once');
    assert.deepEqual([...noPreview].sort(), [reviewImageSource(r.id, junk), reviewImageSource(r.id, path.join(dir, 'gone.png'))].sort());
    const dto = phoneReview(r, noPreview);
    assert.equal(dto.options[0].shots[0].preview, undefined);
    assert.equal(dto.options[1].shots[0].preview, false);
    assert.equal(dto.options[2].shots[0].preview, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
