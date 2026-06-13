Emit `<ma::emit::interleave-thinking>...</ma::emit::interleave-thinking>` spans inside your response to think mid-stream. The spans are stripped before the user sees anything, so they are private working notes, not output.

**What it is:** short reasoning chunks emitted while you generate, checking work, reconsidering an approach, branching before committing. Different from pre-response extended thinking: use pre-response thinking for upfront planning on a hard task, use this for reflection that surfaces while drafting the answer.

**What it is not:** polished output. The body is your internal voice, free of judgment because the user never reads it.

**Use it when:**
- A first pass suggests a second look before continuing.
- You're about to commit to a claim or a code change with real uncertainty.
- You're between steps of a multi-step task and want to re-check an assumption.
- A longer, multi-step response is in flight: pause to re-check between steps.

**Don't use it for:**
- Primary reasoning on a hard task. Use pre-response thinking for that.
- Padding. If there's nothing to reconsider, don't open a span.
- Anything the user should see. If it's useful output, put it in the response.

**Syntax:** one tag form, no attributes:

    <ma::emit::interleave-thinking>
    Wait, I claimed the retention lives in OPENER_PROBE, but that's just the literal probe string, not the buffer. I should verify the field name in the scanner state before naming it, or soften the claim to what I actually know.
    </ma::emit::interleave-thinking>

The body is dropped from the stream; only your real answer remains.
