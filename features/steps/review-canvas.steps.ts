// The review as a board (review-canvas.feature, the reviewCanvas experiment):
// what the open review window's `canvas` says (review_window/canvas.rs,
// `canvas_state`), and a mark drawn as the mouse would draw it.
import { Then, When } from '@cucumber/cucumber';
import { okValue, sleep } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

/** The demo thread's review, the one the board's scenarios open. */
const DEMO_REVIEW = 'review_account_picker';

type CanvasState = { on: boolean; stop: number; stops: number; notesOn: boolean; agentMarks: number; tool: string; marks: string[] };
type WithCanvas = { reply: string; canvas?: CanvasState | null };

async function board(world: ThreadbearWorld, cmd: Record<string, unknown> = {}): Promise<WithCanvas> {
  return JSON.parse(okValue(await world.app.do({ cmd: 'review', id: DEMO_REVIEW, open: false, ...cmd }, 30))) as WithCanvas;
}

async function untilBoard(world: ThreadbearWorld, what: string, check: (s: WithCanvas) => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last: WithCanvas | string = 'no answer yet';
  for (;;) {
    try {
      last = await board(world);
      if (check(last)) return;
    } catch (e) {
      last = (e as Error).message;
    }
    if (Date.now() > deadline) throw new Error(`Never saw: ${what}\n\nThe review said: ${JSON.stringify(last)}`);
    await sleep(150);
  }
}

Then('the review is a board on stop {int} of {int}', async function (this: ThreadbearWorld, stop: number, stops: number) {
  await untilBoard(this, `the board on stop ${stop} of ${stops}`, (s) => !!s.canvas && s.canvas.on && s.canvas.stop === stop && s.canvas.stops === stops);
});

Then("the board has {int} of the agent's notes, showing", async function (this: ThreadbearWorld, count: number) {
  await untilBoard(this, `${count} notes showing`, (s) => !!s.canvas && s.canvas.agentMarks === count && s.canvas.notesOn);
});

Then("the board's notes are hidden", async function (this: ThreadbearWorld) {
  await untilBoard(this, 'the notes hidden', (s) => s.canvas?.notesOn === false);
});

When("I circle a part of option A's picture on the board", async function (this: ThreadbearWorld) {
  await board(this, { canvasMark: { kind: 'circle', option: 0, shot: 0, points: [[0.4, 0.15], [0.7, 0.14], [0.72, 0.24], [0.42, 0.25], [0.4, 0.16]] } });
});

Then('the board has my mark {string}', async function (this: ThreadbearWorld, mark: string) {
  await untilBoard(this, `my mark ${mark}`, (s) => s.canvas?.marks.includes(mark) ?? false);
});

Then("the review's reply is {string}", async function (this: ThreadbearWorld, reply: string) {
  await untilBoard(this, `the reply "${reply}"`, (s) => s.reply.trim() === reply);
});
