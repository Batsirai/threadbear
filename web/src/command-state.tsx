// The one way the website sends a runner a command and follows it to the
// end: useCommand drives the machine in command.ts (every move is there),
// and CommandNote says where it's got to. A control that sends one passes
// `disabled={cmd.busy}` and shows a spinner while it's on its way, so it
// can't be pressed twice (AGENTS.md, "Assume every action is slow to land").
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { commandNote, errorText, idle, locked, slowAt, step, unqueued, type CommandEvent, type CommandState } from './command';

export type Command<P> = {
  state: CommandState<P>;
  // Stops taking clicks: sending, waiting for the runner, or gone slow.
  busy: boolean;
  // Still on its way and nothing's wrong yet: show a spinner.
  spinning: boolean;
  // A press. Ignored while one is on its way, so a double click sends once;
  // `again` lets a composer send its next message once the last is queued.
  run: (send: () => Promise<Id<'commands'>>, payload: P, opts?: { again?: boolean }) => Promise<void>;
  dismiss: () => void;
};

// onQueued: the backend has it (a composer clears its text then, not before).
// onFailed: it didn't happen, whether the backend refused it or the runner
// said so later, with what was sent, to put back.
export function useCommand<P = undefined>(token: string, handlers: { onQueued?: (payload: P) => void; onFailed?: (error: string, payload: P) => void } = {}): Command<P> {
  // The machine's state for the handlers (a double click lands before React
  // renders again), and the same for rendering.
  const now = useRef(idle<P>());
  const [state, setState] = useState(idle<P>);
  const on = useRef(handlers);
  useEffect(() => {
    on.current = handlers;
  });
  const move = useCallback((e: CommandEvent<P>): CommandState<P> => {
    const before = now.current;
    const next = step(before, e);
    if (next === before) return next;
    now.current = next;
    setState(next);
    if (next.kind === 'failed' && before.kind !== 'failed') on.current.onFailed?.(next.error, next.payload);
    if (next.kind === 'waiting' && unqueued(before)) on.current.onQueued?.(next.payload);
    return next;
  }, []);

  const id = state.kind === 'waiting' || state.kind === 'slow' ? state.id : undefined;
  const report = useQuery(api.phone.command, id ? { token, commandId: id as Id<'commands'> } : 'skip');
  useEffect(() => {
    if (id && report) move({ kind: 'report', id, report, at: Date.now() });
  }, [id, report, move]);

  // Goes slow when nothing is heard in time.
  const due = slowAt(state);
  useEffect(() => {
    if (due === undefined) return;
    const t = setTimeout(() => move({ kind: 'tick', at: Date.now() }), Math.max(0, due - Date.now()));
    return () => clearTimeout(t);
  }, [due, move]);

  const run = useCallback(
    async (send: () => Promise<Id<'commands'>>, payload: P, opts?: { again?: boolean }) => {
      const before = now.current;
      const s = move({ kind: 'send', payload, at: Date.now(), ...(opts?.again ? { again: true } : {}) });
      // Refused (one is already on its way): this press does nothing.
      if (s === before || s.kind !== 'sending') return;
      const { attempt } = s;
      try {
        const commandId = await send();
        move({ kind: 'queued', attempt, id: commandId, at: Date.now() });
      } catch (e) {
        move({ kind: 'queueFailed', attempt, error: errorText(e) });
      }
    },
    [move],
  );
  const dismiss = useCallback(() => void move({ kind: 'dismiss' }), [move]);
  return { state, busy: locked(state), spinning: state.kind === 'sending' || state.kind === 'waiting', run, dismiss };
}

// Where a command has got to, under or beside its control: waiting for the
// Mac, gone slow, or failed with why. Nothing while it's idle, sending (the
// control's spinner says so) or done.
export function CommandNote({ command, className = '' }: { command: Pick<Command<unknown>, 'state' | 'dismiss'>; className?: string }) {
  const note = commandNote(command.state);
  if (!note) return null;
  return (
    <div className={`command ${note.tone} ${className}`} role={note.tone === 'failed' ? 'alert' : 'status'}>
      <span>{note.text}</span>
      {note.dismiss ? (
        <button type="button" className="link" onClick={command.dismiss}>
          {command.state.kind === 'slow' ? 'Stop waiting' : 'Dismiss'}
        </button>
      ) : null}
    </div>
  );
}
