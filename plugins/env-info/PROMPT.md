# Environment

A snapshot of the host environment, captured at session start and frozen for the rest of the session. Values like `date_iso` and `term_size` do not refresh as the session runs. Use it to avoid asking the user obvious questions about the platform; re-query with `Bash` (e.g. `date`, `pwd`) when you need a fresh value.
