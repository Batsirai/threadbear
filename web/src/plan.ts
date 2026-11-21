// A Plan first plan (API 72), drawn as a card as the iPhone's PlanCard and
// the Mac's plan card draw it: a port of ThreadbearKit's Plans.title and
// Plans.body. Tests: node --test web/src/plan.test.ts

// The plan's first heading, else its first line, without Markdown marks.
export function planTitle(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l);
  const line = lines.find((l) => l.startsWith('#')) ?? lines[0] ?? '';
  const bare = line.replace(/^#+/, '').trim().replaceAll('**', '').replaceAll('`', '');
  return bare ? bare.slice(0, 120) : 'Plan';
}

// The plan without its title line, for the steps under it.
export function planBody(text: string): string {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first >= 0 && lines[first]!.trim().startsWith('#')) lines.splice(0, first + 1);
  return lines.join('\n').trim();
}

// What a decided plan's card says, from its row's planDecision (API 76).
export function planDecisionLabel(decision: 'go' | 'revise' | undefined): string | undefined {
  return decision === 'go' ? 'Approved' : decision === 'revise' ? 'Sent back' : undefined;
}
