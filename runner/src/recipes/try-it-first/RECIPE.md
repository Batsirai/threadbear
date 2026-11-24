---
name: Try it first
icon: 🧗
description: Before an agent asks you to do a step, it tries the step itself, and only hands you what really needs you.
by: Mike
when: In every thread
color: #2f7d6d
---

## About

Agents are quick to hand work back: "run this and tell me what it prints",
"open the page and check the button", "can you restart the server?". Most of
those are steps the agent could have done with the tools it already has, and
each one costs you a trip back to the thread.

With this on, an agent tries a step before asking you to do it. What it hands
over is what only you can do: a password or a code, a payment, something
physical, an approval that's yours to give. When it does ask, it says what it
tried and what stopped it, so you know the ask is real.

It's a habit, not a job: nothing runs on a schedule. While it's on, every
thread's agent is told the lines below. Mike added it after counting how often
he typed "try it yourself" in a week.

## Example

Without it:

*I've made the change. Could you run the tests and paste what fails?*

With it:

*I've made the change and run the tests: 41 pass, 1 fails, and I fixed that one
(a date that assumed UTC). The only thing I couldn't do is sign in to the
staging site to see it there, as it wants the code from your phone. The sign-in
page is open in the browser, waiting on that code.*

## Habit

Before you ask the user to do a step, try it yourself with the tools you have (the shell, a browser, the app itself). Hand over only what really needs them: a password or a code, a payment, their voice, something physical, an approval that is theirs to give. When you do ask, say exactly what to do and where, and say what you tried and what stopped it. Don't end a turn with a list of checks for them to run that you could have run.
