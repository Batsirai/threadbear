// A design review for the phone (docs/protocol.md, "Reviews on the phone"):
// its words, choices and notes, with each still named by an opaque source
// instead of its path on this Mac. Nothing path-like goes: not the option's
// files, its live url, nor the pictures pasted into a draft on the Mac
// (ReviewDraft.images, which are absolute paths).
//
// Stills go up only once the phone opens a review (reviewStills, from the
// designReviews command in sync.ts), not as reviews are made, so a review
// nobody reads on the phone never leaves the Mac.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DesignReview, ReviewDraft } from './protocol.ts';
import { convertImage } from './images.ts';
import { readReplyImage } from './share-images.ts';

export function reviewImageSource(reviewId: string, imagePath: string): string {
  return `review:${reviewId}:${crypto.createHash('sha256').update(imagePath).digest('hex')}`;
}

// Every shot's still, as its option lists them.
function shotsOf(option: DesignReview['options'][number]) {
  return option.shots ?? [{ image: option.image }];
}

// What the phone may see of a draft: the picks, notes and reply. Not its
// pictures, which are local paths; an answer from the phone keeps the ones
// saved on the Mac (withSavedImages in runner/reviews.ts).
export function phoneDraft(d: ReviewDraft) {
  return {
    notes: d.notes ?? {},
    ...(d.pickedId !== undefined ? { pickedId: d.pickedId } : {}),
    ...(d.pickedIds ? { pickedIds: d.pickedIds } : {}),
    ...(d.reply !== undefined ? { reply: d.reply } : {}),
    ...(d.none ? { none: true as const } : {}),
  };
}

// noPreview: sources whose still can't go to the phone (gone, or not a
// picture even after shrinking), so it says so rather than waiting.
export function phoneReview(review: DesignReview, noPreview: ReadonlySet<string> = new Set()) {
  return {
    id: review.id, title: review.title, status: review.status, revision: review.revision,
    ...(review.note ? { note: review.note } : {}),
    ...(review.recommended ? { recommended: review.recommended } : {}),
    draft: phoneDraft(review.response ?? review.draft),
    options: review.options.map((option) => ({
      id: option.id, title: option.title,
      ...(option.note ? { note: option.note } : {}),
      ...(option.reference ? { reference: true } : {}),
      shots: shotsOf(option).map((shot) => {
        const src = reviewImageSource(review.id, shot.image.path);
        return {
          src,
          ...(shot.title ? { title: shot.title } : {}),
          kind: shot.media?.mediaType === 'text/html' ? 'page' : shot.media ? 'video' : 'image',
          ...(noPreview.has(src) ? { preview: false } : {}),
        };
      }),
    })),
  };
}

// An answer from the phone, as the runner takes it. Built field by field
// from what was checked, so nothing else (pictures above all, which would
// name files on this Mac) comes in with it. Notes come as a list: an option
// id can be any text, and Convex refuses an object key that isn't plain
// ASCII or starts with "$".
export function draftFromPhone(raw: unknown): ReviewDraft {
  const bad = () => new Error('Invalid review answer.');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad();
  const r = raw as Record<string, unknown>;
  const notes: Record<string, string> = {};
  if (!Array.isArray(r.notes)) throw bad();
  for (const n of r.notes) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || typeof n.text !== 'string') throw bad();
    // Object.create(null)-safe: an id of "__proto__" still lands as a key.
    Object.defineProperty(notes, n.id, { value: n.text, enumerable: true, writable: true, configurable: true });
  }
  const out: ReviewDraft = { notes };
  if (r.pickedId !== undefined) {
    if (typeof r.pickedId !== 'string') throw bad();
    out.pickedId = r.pickedId;
  }
  if (r.pickedIds !== undefined) {
    if (!Array.isArray(r.pickedIds) || !r.pickedIds.every((id) => typeof id === 'string')) throw bad();
    out.pickedIds = r.pickedIds as string[];
  }
  if (r.reply !== undefined) {
    if (typeof r.reply !== 'string') throw bad();
    out.reply = r.reply;
  }
  if (r.none === true) out.none = true;
  return out;
}

// Longest side of a still shrunk for the phone: plenty for its screen.
const PHONE_STILL_PX = 2400;

export type ReviewStill = { path: string; src: string };

// A review's stills ready to go up, and the ones that can't. A still over
// the reply-picture limit (10 MB; a review takes 25) or in a format the
// phone's pictures don't take is shrunk to a JPEG beside it once, in the
// review's own media folder, and that copy goes instead.
export async function reviewStills(review: DesignReview): Promise<{ stills: ReviewStill[]; noPreview: Set<string> }> {
  const stills: ReviewStill[] = [];
  const noPreview = new Set<string>();
  const seen = new Set<string>();
  for (const option of review.options) {
    for (const shot of shotsOf(option)) {
      const file = shot.image.path;
      const src = reviewImageSource(review.id, file);
      if (seen.has(src)) continue;
      seen.add(src);
      const ready = await phoneStill(file);
      if (ready) stills.push({ path: ready, src });
      else noPreview.add(src);
    }
  }
  return { stills, noPreview };
}

async function phoneStill(file: string): Promise<string | undefined> {
  if (!('skip' in readReplyImage(file))) return file;
  if (!fs.existsSync(file)) return undefined;
  const small = path.join(path.dirname(file), 'phone', `${path.basename(file, path.extname(file))}.jpg`);
  if (!fs.existsSync(small)) {
    fs.mkdirSync(path.dirname(small), { recursive: true });
    // Made aside and renamed, so one cut short never passes for the still.
    const part = `${small}.part.jpg`;
    if (!(await convertImage(file, part, { format: 'jpeg', quality: 80, maxPx: PHONE_STILL_PX }))) {
      fs.rmSync(part, { force: true });
      return undefined;
    }
    fs.renameSync(part, small);
  }
  return 'skip' in readReplyImage(small) ? undefined : small;
}
