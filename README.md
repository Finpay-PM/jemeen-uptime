# jemeen-uptime

Host-independent outage alerts for Jemeen (checklist N62). Every 5 minutes GitHub
Actions probes the targets in the repository secret `MONITOR_TARGETS`
(format: `targets.example.json`). A target that fails 3 attempts in ~30 s opens one
issue `DOWN: <name>` (label `uptime`); GitHub emails the owner. When it recovers the
issue gets a "Recovered ... after N minutes" comment and is closed (second email).

- Logs show target names and short codes only (e.g. `status_503`, `timeout`).
- A broken monitor (bad config, GitHub API error) fails the run, which GitHub also emails.
- Manual run: Actions -> uptime -> Run workflow (tick "dry run" to probe only).
- Tests: `node --test test/*.test.mjs` (Node 20+, no dependencies).
