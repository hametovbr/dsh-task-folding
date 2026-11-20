# M0 commands

Every command run on the host, in order, with its output. `~` replaces the home
directory; the web launch token is redacted. Outputs are trimmed only where marked
"trimmed"; large dumps are summarised.

Environment: the probe work ran in a scratch Harness home inside the workspace
(`WS=~/repo/dsh-task-folding`, `SCRATCH=$WS/.m0-scratch`, `H=$SCRATCH/dsh-home`) because
`~/.dsh` is read-only to this session's `workspace-write` file policy. The scratch home
and both scratch profiles were deleted at the end; the real `~/.dsh/profiles` was never
written.

## 1. Environment

```
$ uname -a
Linux develop 6.17.13-2-pve #1 SMP PREEMPT_DYNAMIC PMX 6.17.13-2 (2026-03-13T08:06Z) x86_64 GNU/Linux

$ uname -m
x86_64

$ head -6 /etc/os-release
PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
VERSION="13 (trixie)"
VERSION_CODENAME=trixie
DEBIAN_VERSION_FULL=13.6

$ node --version; npm --version; pnpm --version
v24.19.0
11.17.0
11.19.0

$ which dsh; echo "DSH_HOME=$DSH_HOME DSH_PROFILE_DIR=$DSH_PROFILE_DIR"
~/.local/bin/dsh
DSH_HOME=~/.dsh DSH_PROFILE_DIR=~/.dsh/profiles/web

$ ls -l ~/.local/bin/dsh; readlink -f ~/.local/bin/dsh
lrwxrwxrwx 1 developer developer 50 Sep 18 21:39 ~/.local/bin/dsh -> ~/.dsh/runtime/node_modules/.bin/dsh
~/.dsh/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js

$ dsh --version
0.2.2-rc.5

$ ls -1 ~/.dsh/profiles/
node_modules
rescue
web

$ env | grep -i '^DSH'
DSH_WEB_URL, DSH_PROFILE, DSH_PROFILE_DIR, DSH_SHELL, DSH_NODE_EXECUTABLE,
DSH_SESSION_ID, DSH_HOME, DSH_INSTALL_DIR   (all set; values above)

$ node -e "console.log('zstd:', typeof require('node:zlib').zstdDecompressSync)"; which zstd
zstd: function
(no zstd binary on PATH)
```

Installed host packages (`~/.dsh/runtime/node_modules/<pkg>/package.json`):

```
@deepseek-ai/dsh 0.2.2-rc.5
@deepseek-ai/dsh-app-boot 0.2.2-rc.5
@deepseek-ai/dsh-compaction 0.2.2-rc.5
@deepseek-ai/dsh-compaction-basic 0.2.2-rc.5
@deepseek-ai/dsh-llm 0.2.2-rc.5
@deepseek-ai/dsh-session 0.2.2-rc.5
@deepseek-ai/dsh-tools 0.2.2-rc.5
@deepseek-ai/dsh-tool-executor-ptc 0.2.2-rc.5
@deepseek-ai/schemastery 3.19.0
@deepseek-ai/cordis 4.1.0
```

`dsh --help` (verbatim):

```
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>

dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch
layers under your own overrides.

Arguments:
  args                           arguments for the booted profile's app (see:
                                 dsh --profile <name> --help)

Options:
  -V, --version                  output the version number
  --profile <name>               the profile under $DSH_HOME/profiles to boot
  --from-default-profile <name>  replace a custom profile with a fresh copy of a
                                 shipped profile template
  --patch <path>                 extra patch-list overlay applied after the
                                 profile layer (repeatable)
  --dump-config                  print the composed profile tree and exit
  --dump-config-schema           print JSON Schema for profile entries and
                                 patches without mounting
  --dump-default-config          print the profile tree without its user layer
                                 or --patch overlays and exit

Examples:
  dsh web                                   boot the web profile (same as: dsh --profile web)
  dsh rescue --from-default-profile web
                                            recreate rescue from the shipped web template, then boot
  dsh headless "run the tests"              answer one task, print the result, and exit
  dsh tui --patch ./extra.yml               boot a custom profile with one extra overlay
  dsh tui --resume <session>                arguments after the launcher flags reach the app
  dsh web --help                            the web app's own flags and help
  dsh plugin --profile tui add <package>    install a plugin into the tui profile
```

`dsh plugin --help` (verbatim):

```
Usage: dsh plugin [options] [args...]

manage a profile's plugins by forwarding the remaining arguments to pnpm in the
profile directory

Arguments:
  args              pnpm arguments, forwarded verbatim (add <pkg>, remove
                    <pkg>, why <pkg>, ...)

Options:
  --profile <name>  the profile whose plugins to manage (initialized on first
                    use)
  -h, --help        show this help
```

`dsh --profile m0-spike-headless --help` (the headless app's own flags), verbatim:

```
Usage: dsh --profile headless [options] [task...]

Answer one task and exit; the answer goes to stdout and diagnostics to stderr.

Arguments:
  task                        the task text; multiple words are joined by
                              spaces, and `-` reads stdin

Options:
  --json                      write newline-delimited run events to stdout
                              instead of the final message
  --session-id <id>           adopt the persisted Session with this id; an
                              unknown id is an error
  --permission-mode <preset>  select a configured permission preset for this
                              task, including on resume
  --approval-policy <policy>  set approval behavior after selecting the
                              permission preset (choices: "ask", "never")
  --add-dir <path>            allow an additional physical absolute directory
                              under workspace-write (repeatable)
  -h, --help                  show this help
```

## 2. Building and installing the probe

```
$ mkdir -p $SCRATCH/dsh-home && cp ~/.dsh/.credentials.yaml $SCRATCH/dsh-home/.credentials.yaml
$ chmod 600 $SCRATCH/dsh-home/.credentials.yaml
```

Both scratch profiles, created from the shipped templates:

```
$ DSH_HOME=$H dsh --profile m0-spike --from-default-profile web --dump-config > $H/dump-m0-spike-web.txt
$ DSH_HOME=$H dsh --profile m0-spike-headless --from-default-profile headless --dump-config > $H/dump-headless.txt
(rc=0 both; each profile then contains package.json, cordis.yml, cordis.patch.yml, pnpm-workspace.yaml)
```

First install attempt, before pointing pnpm's store into the workspace (fails; the store
is under the read-only `~`):

```
$ DSH_HOME=$H dsh plugin --profile m0-spike add $WS/m0/probe-bundle
[ERR_SQLITE_ERROR] unable to open database file
pnpm: unable to open database file
    at StoreIndex.openDatabase (…/pnpm.mjs:100553:18)
Command failed with exit code 1: pnpm add $WS/m0/probe-bundle
dsh: plugin command failed; diagnostics: $H/profiles/m0-spike/.plugin-manager/logs/operation-IhYwf2/pnpm.log
```

Retry with pnpm's store and XDG dirs inside the workspace (succeeds):

```
$ export npm_config_store_dir=$SCRATCH/pnpm-store \
      XDG_CACHE_HOME=$SCRATCH/xdg/cache XDG_CONFIG_HOME=$SCRATCH/xdg/config \
      XDG_DATA_HOME=$SCRATCH/xdg/data XDG_STATE_HOME=$SCRATCH/xdg/state
$ DSH_HOME=$H dsh plugin --profile m0-spike add $WS/m0/probe-bundle
dependencies:
+ tf-probe link:~/repo/dsh-task-folding/m0/probe-bundle
Already up to date
Done in 1.5s using pnpm v11.19.0

$ DSH_HOME=$H dsh plugin --profile m0-spike-headless add $WS/m0/probe-bundle
dependencies:
+ tf-probe link:~/repo/dsh-task-folding/m0/probe-bundle
Already up to date
Done in 1.2s using pnpm v11.19.0
```

Resulting profile manifests (`dsh plugin add` appends the bundle to
`dsh.profile.bundles`):

```json
// $H/profiles/m0-spike/package.json
{ "name": "dsh-profile-m0-spike", "private": true,
  "dependencies": { "tf-probe": "link:~/repo/dsh-task-folding/m0/probe-bundle" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "tf-probe"] } } }

// $H/profiles/m0-spike-headless/package.json
{ "name": "dsh-profile-m0-spike-headless", "private": true,
  "dependencies": { "tf-probe": "link:~/repo/dsh-task-folding/m0/probe-bundle" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "tf-probe"] } } }
```

`m0-spike-headless/cordis.patch.yml`, as finally used (credentials re-enabled, early
condensation, pruner disabled for the compaction scenario):

```yaml
- id: credentials
  disabled: false
- id: authorization
  disabled: false
- id: deepseek-account
  disabled: false
- id: compaction-basic
  config: { auto: true, headroomTokens: 740000, maxTokens: 8000, retainTokens: 4000, compactionRetries: 0 }
- id: tool-result-pruner
  config: { thresholdChars: 100000000, headChars: 4096, tailChars: 1024 }
```

The threshold arithmetic: `threshold = min(W × thresholdRatio, W − O − headroom)` with
`W = 1048576` (journal `request/context`) and `O = 256000` (maxTokens), i.e. ≈ 52 k tokens
for the second term — small enough that 22 large file reads cross it.

## 3. The web app cannot share a profile with the headless app

```
$ DSH_HOME=$H dsh --profile m0-spike headless --help        # bundles: base, web-app
Usage: dsh --profile web [options]
Serve the DeepSeek Harness browser UI.
  --host <host> …
$ # same result after adding @deepseek-ai/dsh-headless to dsh.profile.bundles …
$ # and after reordering bundles to [base, headless, web-app] … still the web help
```

Hence two scratch profiles. The web profile was started on a loopback port:

```
$ DSH_HOME=$H dsh --profile m0-spike --host 127.0.0.1 --port 3099 --no-open
dsh web: http://127.0.0.1:3099/?token=<redacted>
$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3099/
401     # before opening the printed URL; the page loads after navigating to it with the token
```

## 4. Driving scripted sessions (headless, one process per turn)

```
$ mark() { printf '{"t":%s,"pid":0,"kind":"scenario","name":"%s"}\n' "$(date +%s%3N)" "$1" >> $WS/m0/logs/probe.jsonl; }
$ export DSH_HOME=$H TF_PROBE_LOG=$WS/m0/logs/probe.jsonl

# S0: web surface (browser)
$ mark S0   # then: open http://127.0.0.1:3099/?token=<redacted> and say "hello" in the composer

# S1 turn A
$ mark S1
$ dsh --profile m0-spike-headless headless --json "Call probe_meta with label A."
{"type":"session","sessionId":"session-97c7cd80-3d2e-4413-a8ea-48c70c6197f4","cwd":"~/repo/dsh-task-folding"}
…
{"type":"final","sessionId":"session-97c7cd80-…","reason":{"kind":"completed"},"text":"probe_meta returned: `probe ok: A`"}

# S1 turn B: separate process, same session (the "restart")
$ dsh --profile m0-spike-headless headless --json --session-id session-97c7cd80-3d2e-4413-a8ea-48c70c6197f4 "Call probe_meta with label B."
{"type":"session","sessionId":"session-97c7cd80-…","cwd":"~/repo/dsh-task-folding"}
{"type":"status","phase":"turn_start","turn":2}
…
{"type":"final",…,"text":"probe_meta returned: `probe ok: B`"}

# S2: one message, three calls
$ mark S2
$ dsh --profile m0-spike-headless headless --json "In ONE message, call probe_sleep with label X and ms 3000, probe_sleep with label Y and ms 3000, and probe_meta with label Z."
… tool_call probe_sleep X, tool_call probe_sleep Y, tool_call probe_meta Z …
{"type":"final",…,"text":"All three probes ran in one message: …"}

# S3: 22 large reads with the pruner active (23 compaction/prune + 23 replacement tool/result events)
$ mark S3
$ dsh --profile m0-spike-headless headless --json "Read each of these files with the read tool, one tool call per file … (22 paths under ~/.dsh/runtime/node_modules/@deepseek-ai/dsh/docs)" 
{"type":"session","sessionId":"session-73ff4976-2f77-4fc7-a435-387e9164f9f7",…}
tool calls: 22

# S3b: same list with the pruner disabled → three automatic checkpoints
$ mark S3b
$ dsh --profile m0-spike-headless headless --json "Read each of these files … (22 paths)"
{"type":"session","sessionId":"session-ccda47b7-cf8e-4fa8-afca-9298b7ca2ec7",…}
tool calls: 22

# S4: run_code is not mounted in the shipped composition
$ mark S4
$ dsh --profile m0-spike-headless headless --json "Using run_code, write a program that calls probe_meta with label P."
… the model searched for run_code, found it absent, called probe_meta directly …
{"type":"final",…,"text":"I couldn't do it via `run_code` — that tool isn't mounted in this session …"}
```

Enabling PTC for the S4 retry, in the scratch profile only (two attempts):

```
# attempt 1: enable PTC while native stays enabled → boot fails
$ dsh --profile m0-spike-headless --json "Using run_code, …"     # patch: tool-executor-ptc disabled:false
dsh: no agent factory registered (load an agent-loop plugin)
dsh: startup failed: 1 required plugin did not activate

Failed plugins (1):
  tool-executor-ptc (required)
    Package: @deepseek-ai/dsh-tool-executor-ptc
    Error: Only one tool executor may be registered in each scope
```

```yaml
# attempt 2: exactly one executor
- id: tool-executor-native
  disabled: true
- id: tool-executor-ptc
  disabled: false
```

```
$ mark S4
$ dsh --profile m0-spike-headless --json "Using run_code, write a program that calls probe_meta with label P."
{"type":"session","sessionId":"session-3ec7ff7a-5e80-43d7-a8b4-64507c4495cb",…}
{"type":"tool_call","callId":"call_00_ET_VKghNLF97R4TbYXuDCXH3922","tool":"run_code",
 "input":{"code":"const result = await tools.probe_meta({ label: \"P\" }); …"}}
stderr: (node:7) ExperimentalWarning: stripTypeScriptTypes is an experimental feature …

# S4b: a second probe tool that reports its own exec context from inside run_code
$ DSH_HOME=$H dsh plugin --profile m0-spike-headless add $SCRATCH/tf-probe2
+ tf-probe2 link:~/repo/dsh-task-folding/.m0-scratch/tf-probe2
$ dsh --profile m0-spike-headless --json "Using run_code, call probe_exec with label Q."
{"type":"session","sessionId":"session-2331fd67-83f6-4893-a0d4-3f8b4143df60",…}
```

Probe log lines produced by S4 / S4b:

```
{"kind":"exec","tool":"probe_meta","label":"P","rootCallId":"call_00_ET_VKgh…","hasAgent":true,"sessionId":"session-3ec7ff7a-…"}
{"kind":"exec2","label":"Q","keys":["token","callId","rootCallId","name","signal","agent","toolSet","parent","schema","deferContext","concludeTurn","arguments"],
 "pick":{"callId":"call_00_Kk1XGQRKd8xDW964f9vz6345:ptc:1","rootCallId":"call_00_Kk1XGQRKd8xDW964f9vz6345","name":"probe_exec",…}}
```

S5 and S3c ran in the interactive web session (browser), through `ego_script` driving the
composer. The recorded ego marks:

```
{"what":"sent turn 1","at":1795187800603}                                  # "Say OK and nothing else."
{"what":"turn 1 end","at":1795187802716,"sawStop":true}                    # 'Stop generating' disappeared
{"what":"sent turn 2","at":1795187803174,"deltaAfterEnd":450}              # "Call probe_meta with label M."
# /compact was sent the same way, in the same session, from the composer
```

S6 (fork) was driven in the browser: open the S1 session, click
"Branch into a new conversation" on the first assistant reply (which opens
`Headless Call probe_meta test (1)`), then send "Call probe_meta with label F.".

## 5. Reading the session log

```
$ node $SCRATCH/zstd-to-jsonl.mjs \
    $H/sessions/--home-developer-repo-dsh-task-folding--/session-73ff4976-…/session.v4.jsonl.zstd \
    m0/sessions/S3.jsonl
{"frames":97,"bytesIn":596956,"bytesOut":2420592,"lines":203}
```

The script splits the buffer on the zstd magic `28 b5 2f fd` and decompresses each frame
with `zlib.zstdDecompressSync` (the journal is concatenated frames; there is no zstd
binary on the host). Other decodes:

```
S1   frames 21  bytesIn 29398   lines 46
S2   frames 13  bytesIn 21776   lines 33
S3b  frames 102 bytesIn 415947  lines 182
S0-S3c-S5 frames 39 bytesIn 37474 lines 81
S4   frames 11  bytesIn 23266   lines 31
S4b  frames 12  bytesIn 23345   lines 31
S6   frames 12  bytesIn 42257   lines 53
```

## 6. Q4 layout test

```
# linked install (what dsh plugin add <local path> produced): all four bare imports fail
{"kind":"resolve","spec":"@deepseek-ai/dsh-compaction-basic","ok":false,
 "error":"Cannot find package '@deepseek-ai/dsh-compaction-basic' imported from ~/repo/dsh-task-folding/m0/probe-bundle/index.js"}
… same for dsh-compaction, dsh-llm, schemastery …

# copied package inside the profile + a profiles/node_modules level (as in the real home)
$ rm -f $H/profiles/m0-spike-headless/node_modules/tf-probe
$ cp -r $WS/m0/probe-bundle $H/profiles/m0-spike-headless/node_modules/tf-probe
$ for pkg in dsh-compaction-basic dsh-compaction dsh-llm schemastery; do
    ln -sfn ~/.dsh/runtime/node_modules/@deepseek-ai/$pkg $H/profiles/node_modules/@deepseek-ai/$pkg; done
$ dsh --profile m0-spike-headless --json "Reply with exactly: Q4OK"
{"kind":"resolve","spec":"@deepseek-ai/dsh-compaction-basic","ok":true,"keys":["BasicCompactionEngine","default"]}
{"kind":"resolve","spec":"@deepseek-ai/dsh-compaction","ok":true,"keys":["CompactionEngine","CompactionId","ManualCompactionError",
 "compactCheckpointSource","default","isCompactCheckpointSource","toolPairingBalancedAfter","toolPairingBalancedBefore"]}
{"kind":"resolve","spec":"@deepseek-ai/dsh-llm","ok":true,"keys":["ACCOUNT_QUOTA_EXCEEDED_CODE","APP_IDENTITY","AssistantStreamAccumulator",…]}
{"kind":"resolve","spec":"@deepseek-ai/schemastery","ok":true,"keys":["default"]}
```

## 7. Browser observations (S0 / Q7)

```
ego_navigate http://127.0.0.1:3099/?token=<redacted>          → DeepSeek Harness, 1280x813
ego_snapshot                                                  → DOM text "TF-PROBE conversation.input.dock"
ego_screenshot m0/logs/s0-dock-tag.png                         → tag visible above the composer
ego_script: page.evaluate(...) after opening a session        → ["TF-PROBE conversation.input.dock",
                                                                  "TF-PROBE conversation.composer.dock"]
ego_script: page.on(...)                                       → typeof page.on === "function" was false;
                                                                 drainEvents() returned 330 events, none of them console
```

## 8. Cleanup (start of the end-state verification)

```
$ ls -l ~/.dsh/profiles/web/package.json                      # unchanged since the snapshot in §1
$ cat ~/.dsh/profiles/web/package.json                        # 17 bundles, identical to the recorded list
$ ls -1 ~/.dsh/profiles/                                      # node_modules, rescue, web   (no m0-spike)
$ rm -rf $SCRATCH                                             # scratch home + both profiles + probe installs
```
