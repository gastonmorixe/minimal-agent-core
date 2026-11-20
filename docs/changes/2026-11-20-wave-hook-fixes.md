# Wave hooks: `tool.willInvoke` and `tool.didInvoke` fixes

Date: 2026-11-20. Scope: core (wave scheduler `src/sdk/tool-call-waves.ts`,
tool round `src/loops/tool-round.ts`, SDK port `ToolCallGates`). Follow-ups
12b and 9 of `2026-11-20-concurrent-tool-calls.md`. Spec:
`research/fix-wave-hooks-spec.md` (umbrella repo). Terms: `GLOSSARY.md`
(run, tool call, admission, batch, wave, concurrency-safe, serial call,
concurrency cap).

## The rule

In a wave, `tool.willInvoke` runs for a call only when the call can start
right after it. `tool.didInvoke` runs only for a call whose result is
saved. Cap 1 and the serial path do not change (the goldens are
unchanged).

## Bug 12b: `tool.didInvoke` for a result that is never saved

The post-run section runs one call at a time. When call `b` leaves the
section, the section goes to the next waiter `c` (`c` becomes the holder,
and its wait resolves). The continuation of `c` runs later. If the loop
fails at a call `j <= c` before that continuation runs (for example, the
save of an earlier call throws), `c` still ran its result chain,
`tool.didInvoke` and the blob write. Its result is never saved.

The fix: after a call gets the section, it checks the failure again. If
the loop failed at this call or earlier, the call gives the section to the
next waiter (an earlier waiter still gets its real result) and stops with
no post-run step. The call also checks again after it waits for the
earlier calls (`inCallOrder`) and before its save, for the same gap.

## Bug 9: `tool.willInvoke` for a call that waits for a slot

Before, a concurrency-safe call ended its admission, let the next
admission go, and then waited for a run slot. With more calls than the
concurrency cap, the calls past the cap passed `tool.willInvoke` (an ACP
host can ask a human) and then waited. An abort during that wait gave a
`tool.willInvoke` with no run.

The fix: a wave call gets its run slot before its admission. The order for
each call is:

1. `tool_call` and the `running_tool` status (announce before ask).
2. Wait until the admission of the call before it ends.
3. Get a run slot (new optional gate `ToolCallGates.beforeAdmission`; the
   tool round calls it after the mode gate and the input check, right
   before `tool.willInvoke`).
4. Admission (`tool.willInvoke`), then the per-input check.
5. Concurrency-safe: the call runs at once with its slot. Not safe: the
   call gives its slot back, waits for all earlier calls, and runs alone.

An abort while a call waits for its slot gives the "tool aborted by user"
result with no `tool.willInvoke` and no `tool.didInvoke`
(`tool.permissionChecked`, an observe hook, fires before the slot wait).
This is the same path as a call that never started.
Admission still runs one call at a time in call order. A refused call
(mode gate, input error) gets no slot. A call that `tool.willInvoke`
denies gives its slot back.

An executor that does not call `beforeAdmission` works as before: it gets
its slot after admission.

## The effect: a slow human approval holds one run slot

A call in admission holds a run slot. When a human takes a long time to
answer an approval, that slot does not run another call. The next
admission waits too (as before). Thus, at most `cap - 1` other calls can
run while a human answers.

## No deadlock

- The run slots are FIFO, and admission runs in call order. Thus the slots
  go to the calls in call order.
- A call in admission holds at most one slot. The next admission starts
  only after this admission ends, so at most one slot is held by a call
  in admission.
- A call that holds a slot after its admission waits only for its own run.
  The run ends, and the call releases its slot before it waits for the
  post-run section or for earlier calls. A serial call gives its slot back
  before it waits for earlier calls. Thus no call holds a slot while it
  waits for a call that needs a slot.

## The remaining case (X2)

A call that the per-input check makes serial waits for the earlier calls
AFTER its `tool.willInvoke`: the per-input check needs the final input,
which comes from admission. An abort during that wait still gives a
`tool.willInvoke` with no run. This case cannot be removed.

The serial path has the same case: the tool round has no signal check
between `tool.willInvoke` and the run. A user abort after
`tool.willInvoke` gives a call that ends with the aborted result and no
`tool.didInvoke`. `docs/hooks.md` documents both.

## Loop failures (not a user abort)

These cases occur only when saving an earlier result fails.

- A loop failure during admission: when the loop itself fails (for
  example, a save throws) while a later call is in `tool.willInvoke`, that
  call ends with no run.
- A loop failure during the post-run steps: when the loop fails while a
  later call already runs its post-run steps (in the post-run section),
  the `tool.didInvoke` of that call can still run, but its result is not
  saved. The fix for bug 12b closes only the gap between "the call gets
  the section" and "the call continues". Only a serial order can remove
  this case.

## Out of scope

An abort signal for `tool.willInvoke` (follow-up 8), and the follow-ups
12a, 12c and 12d.

## Tests

- `src/sdk/tool-call-waves.test.ts`: "the section goes to a waiter, then
  the loop fails before the waiter resumes: no post-run steps for it".
- `src/sdk/tool-call-waves.round.test.ts` (the real tool round): "cap 2, 4
  safe calls: abort while calls 3-4 wait for a slot gives 2 willInvoke,
  not 4"; "admission of call k+1 starts only after call k has its slot; a
  slow approval holds one slot"; "abort while a human approval is pending
  for b and c-d wait: after the answer, c and d end aborted with no
  tool.willInvoke (no deadlock)"; "a call that the per-input check makes
  serial gives its slot back (X2)"; "serial path: user abort after
  tool.willInvoke > a built-in call ends with the aborted result and no
  tool.didInvoke".
- Unchanged and green: the 12 calls at cap 10 test, the wall-time tests,
  and the goldens (`src/sdk/tool-turn-golden.test.ts`,
  `src/agent/tool-outcome-golden.test.ts`).
