<ma::agent::turn-aborted />
The previous turn was interrupted by the user before it finished. Everything already completed above is preserved (this is not an error). Treat the earlier plan as paused: address the new instruction below, and do not silently resume the prior plan unless the user asks you to continue it.
