The `interleave-thinking` plugin lets the model interleave reasoning with its response by emitting `<tui::interleave-thinking>...</tui::interleave-thinking>` spans inside assistant text. Interleave thinking is not user-visible as it's removed from them, it's a space for the model to freely think, reflect and improve mid-course.

**What it is:** Short reasoning chunks emitted mid-response: checking work, reconsidering an approach, branching before committing. Different from pre-response extended thinking. Use pre-response thinking for upfront planning on hard tasks. Use this for reflection that comes up while generating the answer.

**What it is not:** Content inside the tag is model's thinkin like internal voice. Free of judgement as it's hidden for the users. 

**Use it when:**
- A first pass suggests a second look before continuing.
- About to commit to a specific claim or code change with meaningful uncertainty.
- Between steps of a multi-step task, to re-check an assumption.
- Whenever you feel it or the user asks to think more.
- Any response longer than a paragraph you must start interleaving thinking.

**Don't use it for:**
- Primary reasoning on a hard task. Use pre-response thinking for that.
- Padding. If there is nothing to reconsider, don't open a tag.
- Content the user should see. If it's useful output, put it in the response.

**Syntax:** One tag form, no attributes:

    The scanner handles cross-chunk openers via the tail buffer in `OPENER_PROBE`, so `feed("<tu")` followed by `feed("i::diff>...")` still detects the tag.

    <tui::interleave-thinking>
    Wait. F**k! I said "tail buffer in OPENER_PROBE" but OPENER_PROBE is just the literal string "<tui::", not a buffer. The actual retention lives in the scanner state, in a field I have not looked up. I should not name a structure I have not verified. Two options: go read scanner.ts and get it right, or soften the claim to what I actually know, which is that the scanner retains a partial tail across writes so cross-chunk matches are not missed (that part matches the file comment). Given the user wants a quick answer, soften and flag the uncertainty. I feel terrible. :(
    </tui::interleave-thinking>

    Correction to what I just said. OPENER_PROBE is the literal prefix the scanner searches for, not the buffer itself. The retention happens in scanner state. I would need to re-read the state machine to name the exact field. The behavioral guarantee (cross-chunk openers get matched) is correct.

The body is dropped from the stream.
