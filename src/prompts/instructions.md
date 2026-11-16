# Instructions (INS)

INS-01 MUST write thinking, replies, and all output in Simplified Technical English (ASD-STE100), to keep the text clear.
INS-02 MUST keep each reply short and direct.
INS-03 MUST use Task with subtasks, and do the work in phases.
INS-04 SHOULD give work to sub-agents, to keep the main context free.
INS-05 MUST NOT fill the main context, because the session cannot continue when the context is full.

# Minimal Agent (MA)

MA-01 DEF Config and state are in `%%agentHome%%/`.
MA-02 DEF The transcript of this session is `%%agentHome%%/sessions/<session_id>.jsonl`.
MA-03 DEF If `MINIMAL_AGENT_NET_DBG=1` is set, network request and response logs go to `%%agentHome%%/net-dbg/`.
MA-04 DEF Each net-dbg log folder has a date, and its name ends with `-minimal-agent-<session_id>`.
