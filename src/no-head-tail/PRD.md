# block-head-tail — Behaviour Specification

## Purpose

Transparently strip `| head -n N` and `| tail -n N` pipe truncations from
bash commands before they reach the `bash` tool execute handler.
This prevents model-generated commands from silently truncating output that
the agent needs to see for correct analysis.

## Architecture (plugin hook)

```
OpenCode tool.execute.before hook
        │
        ├── headTailStrippingHook['tool.execute.before'](input, output)
        │       └─ if input.tool === 'bash' and args.script is a string:
        │           stripHeadTailPipes(args.script)
        │           → rewrite args.script with cleaned command
        │
        └── other hooks (apply-patch, etc.)
                └─ see cleaned script for bash tool
```

The hook runs **first** in the `tool.execute.before` pipeline, before all
other hooks (apply-patch, task-session-manager). This ensures:

- All downstream hooks and the final execute handler see the **cleaned** script
- The stripping is transparent — no notes or warnings are appended to output
- Background process results are unaffected (the hook only rewrites `args.script`)

## Regex

```
/\s*\|\s*(head|tail)\s+(?:-n\s*|-)\d+(?=\s*(?:[;&\n#]|$))/g
```

| Token          | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `\s*`          | optional whitespace before the pipe symbol                               |
| `\|`           | literal pipe (escaped)                                                   |
| `\s*`          | optional whitespace after the pipe                                       |
| `(head\|tail)` | tool name (capture group 1); lowercase only                              |
| `\s+`          | required whitespace before the flag                                      |
| `(?:-n\s*\|-)` | non-capturing group: `-n` + optional space, **or** bare `-` (short form) |
| `\d+`          | line count (one or more digits)                                          |
| `(?=\s*(?:[;&\n#]\|$))` | lookahead: must be followed by whitespace, semicolon, ampersand, newline, hash, or end of string |
| `g`            | global — replace all occurrences                                         |

## Matching (stripped)

| Form                     | Example                                    |
| ------------------------ | ------------------------------------------ |
| `\| head -n N` long form | `cat file \| head -n 50`                   |
| `\| head -nN` no space   | `ls -la \| head -n10`                      |
| `\| tail -n N` long form | `dmesg \| tail -n 20`                      |
| `\| tail -nN` no space   | `git log \| tail -n5`                      |
| `\| head -N` short form  | `cat file \| head -5`                      |
| `\| tail -N` short form  | `dmesg \| tail -3`                         |
| `\| tail -NNN` large N   | `journalctl -u nginx \| tail -100`         |
| Multi-pipe chain         | `cat big.log \| head -n 100 \| tail -n 10` |
| Extra whitespace        | `ps aux  \|    head -n 30`                 |

## Not matching (pass-through)

| Form                          | Reason                                      |
| ----------------------------- | ------------------------------------------- |
| `\| Head -n 50`               | uppercase `H` (case-sensitive match)        |
| `\| HEAD -10`                 | all caps (case-sensitive match)             |
| `head -n 5 file.txt`          | no pipe before `head`                       |
| `tail -n 20 file.txt`         | no pipe before `tail`                       |
| `grep -n pattern`             | different `-n` flag (no pipe, no head/tail) |
| `cat file \| grep -n pattern` | grep's `-n` is not head or tail             |
| `cat file \| tail -n +50`     | offset flag with `+` must be pass-through   |
| `""`                          | empty string                                |

## Function: `stripHeadTailPipes(script)`

**Input:** `string` — the raw bash command script
**Output:** `{ script: string, stripped: { pipe, name, count }[] }`

- `script` — the command with all matching head/tail pipe suffixes removed
- `stripped` — ordered array of removed pipes:
  - `pipe` — the trimmed text of the removed pipe (e.g. `"| head -n 50"`)
  - `name` — `"head"` or `"tail"`
  - `count` — the parsed numeric argument

**Idempotent:** calling again on already-cleaned output returns the same
output with an empty `stripped` array.

## Hook: `createHeadTailStrippingHook()`

Returns an object with a `tool.execute.before` method that:

1. Checks if `input.tool === 'bash'`
2. Checks if `output.args?.command` is a string
3. Calls `stripHeadTailPipes` on the command
4. If any pipes were stripped, rewrites `output.args.command` with the cleaned version
5. Logs the stripped pipes for debugging

**Behavior:**
The hook silently and transparently rewrites `args.script` before any other
hook or the final execute handler processes the bash command, without appending
notes or warnings to the final output or notification channels.

## Interaction with other hooks

| Hook                          | Behaviour                                                                 |
| ----------------------------- | ------------------------------------------------------------------------- |
| `apply-patch`                 | Runs after head-tail stripping, sees cleaned bash script                  |
| `task-session-manager`        | Unaffected — operates on different tools                                  |
| `tool.execute.after` hooks    | Unaffected — operate on results, not inputs                               |
| `bash` tool internals         | Receives cleaned script (no `\| head -n N`), full output flows correctly |

## Configuration

No opt-out parameter is added. The feature is always transparently active.
If an opt-out proves necessary in the future, a `disable_head_tail_stripping`
boolean parameter can be added to the plugin config without breaking existing
behaviour.
