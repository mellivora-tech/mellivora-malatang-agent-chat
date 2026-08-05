# Project instructions

## Runtime data lives OUTSIDE this workspace

- App data root: `$MELLIVORA_DATA_DIR` (default `~/.mellivora`).
- Run logs / run records: `<data root>/logs/` (e.g. `runs-index.jsonl`).
- Questions like "what did the last request use / when did a run happen / which model" are answered by reading that directory — do NOT reverse-engineer runtime paths from `src/`.

## Probing discipline

- Probe narrow first: give grep a `path`/`glob` (or use `filesOnly`) instead of a bare case-insensitive word; a wide un-scoped search dumps huge output and buries the answer.
- Runtime facts need RUNTIME probes: `echo $ENV`, `ls <data root>` — not more greps of source code.
- When a tool result CONFIRMS a runtime fact (paths, env vars, data locations), record it once with `remember_fact` so later turns and later runs reuse it instead of re-deriving it.
