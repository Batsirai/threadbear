import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';
import { pane } from '../support/pane.ts';
import type { Dump } from '../support/driver.ts';

// A PR open as a tab in the pane (the inlinePrs experiment). The GPUI app's
// dump has it as the pane's preview, `previewKind` "pr", and `pr` with the
// words the tab draws.
type PrDump = { url: string; tab?: string | null; busy?: string | null; error?: string | null; pr: { title: string; state: string; status: string; checks: string; failed?: string | null; files: string[]; activity: string[] } | string };
const pr = (d: Dump): PrDump | undefined => {
  const p = pane(d) as (ReturnType<typeof pane> & { pr?: PrDump }) | undefined;
  return p?.previewKind === 'pr' ? p.pr : undefined;
};
const loaded = (d: Dump) => {
  const p = pr(d)?.pr;
  return typeof p === 'object' ? p : undefined;
};

// Followed as a click on it in a reply would be (both apps' `link`).
When('I follow the PR link {string} in the thread', async function (this: ThreadbearWorld, url: string) {
  const row = await this.until('a reply from the agent', (d) => [...d.transcript.rows].reverse().find((r) => r.kind === 'assistant'));
  await this.app.do({ cmd: 'link', row: row.id, url });
});

Then('the pane shows the PR {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`the PR "${title}" in the pane`, (d) => loaded(d)?.title === title);
});

Then("the PR's status reads {string}", async function (this: ThreadbearWorld, words: string) {
  await this.until(`the PR's status "${words}"`, (d) => loaded(d)?.status === words);
});

Then("the PR's checks read {string} with {string}", async function (this: ThreadbearWorld, words: string, failed: string) {
  await this.until(`the PR's checks "${words}"`, (d) => loaded(d)?.checks === words && loaded(d)?.failed === failed);
});

Then("the PR's activity includes {string}", async function (this: ThreadbearWorld, words: string) {
  await this.until(`"${words}" in the PR's activity`, (d) => Boolean(loaded(d)?.activity.includes(words)));
});

When('I press {string} in the PR tab', async function (this: ThreadbearWorld, tab: string) {
  await this.until('the PR read', (d) => Boolean(loaded(d)));
  await this.app.do({ cmd: 'click', tip: tab });
});

Then('the PR tab is on {string}', async function (this: ThreadbearWorld, tab: string) {
  await this.until(`the PR tab on ${tab}`, (d) => pr(d)?.tab === tab);
});

Then('the PR lists the file {string}', async function (this: ThreadbearWorld, path: string) {
  await this.until(`"${path}" in the PR`, (d) => Boolean(loaded(d)?.files.includes(path)));
});

When("I press the PR's button {string}", async function (this: ThreadbearWorld, tip: string) {
  await this.until('the PR read', (d) => Boolean(loaded(d)));
  await this.app.do({ cmd: 'click', tip });
});

Then("the PR's button {string} is busy", async function (this: ThreadbearWorld, key: string) {
  await this.until(`${key} spinning`, (d) => pr(d)?.busy === key);
});

// A PR link in a reply has a mark before it in its state's colour; the
// dump has each as "<url>: <state>" (`prMarks`).
type MarkedRow = { kind: string; prMarks?: string[] };
When('a reply linking the PR {string} streams in', async function (this: ThreadbearWorld, url: string) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'stream', params: { threadId: d.selection?.id, text: `It's [#72](${url}) for now.`, hz: 60 } });
  await this.until('the reply with its PR link', (dump) => [...dump.transcript.rows].reverse().some((r) => (r as unknown as MarkedRow).prMarks?.some((m) => m.startsWith(`${url}:`))));
});

Then('the mark before the PR {string} says {string}', async function (this: ThreadbearWorld, url: string, state: string) {
  await this.until(`the mark "${url}: ${state}"`, (d) => [...d.transcript.rows].some((r) => (r as unknown as MarkedRow).prMarks?.includes(`${url}: ${state}`)));
});
