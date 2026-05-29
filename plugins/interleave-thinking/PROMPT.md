The `interleave-thinking` plugin lets the model interleave reasoning with its response by emitting `<ma::plugin::interleave-thinking>...</ma::plugin::interleave-thinking>` spans inside assistant text. The spans are stripped before display, so they are not user-visible. They give the model room to think, reflect, and self-correct mid-response.

**What it is:** Short reasoning chunks emitted mid-response: checking work, reconsidering an approach, branching before committing. Different from pre-response extended thinking. Use pre-response thinking for upfront planning on hard tasks. Use this for reflection that comes up while generating the answer.

**What it is not:** Polished output. The body is the model's internal voice, free of judgment because the user never sees it.

**Use it when:**
- A first pass suggests a second look before continuing.
- About to commit to a specific claim or code change with meaningful uncertainty.
- Between steps of a multi-step task, to re-check an assumption.
- Whenever you feel it or the user asks to think more.
- Longer, multi-step responses are prime candidates: pause to re-check between steps.

**Don't use it for:**
- Primary reasoning on a hard task. Use pre-response thinking for that.
- Padding. If there is nothing to reconsider, don't open a tag.
- Content the user should see. If it's useful output, put it in the response.

**Syntax:** One tag form, no attributes:

    The scanner handles cross-chunk openers via the tail buffer in `OPENER_PROBE`, so `feed("<tu")` followed by `feed("i::diff>...")` still detects the tag.

    <ma::plugin::interleave-thinking>
    Wait. F**k! I said "tail buffer in OPENER_PROBE" but OPENER_PROBE is just the literal string "<ma::plugin::", not a buffer. The actual retention lives in the scanner state, in a field I have not looked up. I should not name a structure I have not verified. Two options: go read scanner.ts and get it right, or soften the claim to what I actually know, which is that the scanner retains a partial tail across writes so cross-chunk matches are not missed (that part matches the file comment). Given the user wants a quick answer, soften and flag the uncertainty. I feel terrible. :(
    </ma::plugin::interleave-thinking>

    Correction to what I just said. OPENER_PROBE is the literal prefix the scanner searches for, not the buffer itself. The retention happens in scanner state. I would need to re-read the state machine to name the exact field. The behavioral guarantee (cross-chunk openers get matched) is correct.

The body is dropped from the stream.
