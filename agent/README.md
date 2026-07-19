# Relaydot agent core

Relaydot is an early-stage endpoint-agent core for safely inventorying, packaging,
merging, and applying selected AI coding-tool state.

The published `0.1.x` package is **not yet a complete synchronization client**.
It includes the local safety primitives and these CLI commands:

```text
relaydot --version
relaydot config validate
relaydot config show
relaydot sync inventory
relaydot enroll --server URL --token TOKEN
relaydot sync now
relaydot service run
relaydot service install --start
relaydot doctor
```

Enrollment, authenticated heartbeat, durable command polling/acknowledgement,
foreground service operation, and per-user launchd/systemd/Scheduled Task
installation are implemented. For a persistent managed node, prefer
`relaydot service install --start`; `service run` is the foreground diagnostic
mode. Remote package updates and complete cross-device revision transfer remain
planned. See the repository README and implementation plan for the full product
scope.
