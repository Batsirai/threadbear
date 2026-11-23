import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { Dump } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

// The quiet inbox for Mike's own threads (experiment quietInboxMine): the
// Inbox's "Quietly archived: N today" line and its list. `dump`'s
// `sidebar.quiet` has the line, whether the list is open, and its threads.
type Quiet = { line: string; open: boolean; threads: { id: string; title: string; why: string }[] } | null | undefined;
const quiet = (d: Dump): Quiet => (d.sidebar as { quiet?: Quiet }).quiet;

Given('the quiet inbox archived {string} and {string} today', async function (this: ThreadbearWorld, first: string, second: string) {
  await this.until('the threads listed', (d) => Boolean(this.thread(d, first) && this.thread(d, second)));
  await this.app.do({ cmd: 'mock', method: 'quietArchive', params: { titles: [first, second] } });
  await this.until('the quiet line', (d) => Boolean(quiet(d)));
});

Given('the runner will refuse the next Should have shown me', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'quietArchive', params: { refuse: true } });
});

Then('the foot of the Inbox says {string}', async function (this: ThreadbearWorld, line: string) {
  await this.until(`"${line}" at the foot of the Inbox`, (d) => quiet(d)?.line === line);
});

// Its real click, by its tooltip.
When('I open the quietly archived list', async function (this: ThreadbearWorld) {
  await this.until('the quiet line', (d) => Boolean(quiet(d)));
  await this.app.do({ cmd: 'click', tipPrefix: 'Show the threads archived today' });
  await this.until('the list open', (d) => quiet(d)?.open === true);
});

Then('the quietly archived list is {string}, {string}', async function (this: ThreadbearWorld, first: string, second: string) {
  await this.until(`the list "${first}", "${second}"`, (d) => {
    const q = quiet(d);
    return q?.open === true && q.threads.map((t) => t.title).join('|') === `${first}|${second}`;
  });
});

When('I press Should have shown me on {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" in the list`, (d) => Boolean(quiet(d)?.threads.some((t) => t.title === title)));
  await this.app.do({ cmd: 'click', tipPrefix: `Should have shown me: bring “${title}”` });
});

Then('the runner was told I should have been shown {string}', async function (this: ThreadbearWorld, title: string) {
  let last: { threadId?: string } | null = null;
  for (let tries = 0; tries < 50 && !last; tries += 1) {
    const text = await this.app.do({ cmd: 'mock', method: 'lastWrongHide', params: {} });
    last = ((typeof text === 'string' ? JSON.parse(text) : text) as { params?: { threadId?: string } }).params ?? null;
    if (!last) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const d = await this.app.dump();
  assert.equal(last?.threadId, this.thread(d, title)?.id);
});
