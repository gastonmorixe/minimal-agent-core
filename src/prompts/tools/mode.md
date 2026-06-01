Returns the currently active operating mode (e.g. ASK) and its tool-permission policy. Call when you are uncertain whether a mode is active (e.g. after long thinking or many tool rounds) and you want a deterministic answer instead of guessing from earlier reasoning.

The result is a JSON object: `{ id, label, since, permissions: { allow, deny } }`. `id: null` means no mode is active (fully unrestricted). `allow: ["*"]` means every tool is allowed except those in `deny` (deny wins on overlap).

You do NOT need to call this routinely : every tool_result you receive carries a trailing `<ma::agent::mode-active id=... since=... />` stamp with the same id. Use this tool when no recent tool round has fired and you want to confirm.
