# Replacing the Syncthing implementation

Relaydot and Syncthing must not concurrently write the same managed paths during
normal operation. The migration uses a controlled import window and preserves a
rollback copy until all machines agree on the published baseline.

## Migration workflow

1. Inventory every Syncthing device, its operating system, current folder ID,
   ignore rules, and last successful synchronization time.
2. Install Relaydot in `observe-only` mode on each machine. It assigns an immutable
   device ID, proposes the OS hostname as its display name, inventories allowed
   files, and parses historical usage without changing files.
3. Pause the Syncthing share everywhere. Do not remove it yet.
4. Capture a read-only backup/snapshot of every machine's complete selected roots.
5. Upload each inventory to an import workspace. Deduplicate identical conversation
   records and configuration files; show divergent files and source machines.
6. Assign ambiguous historical sessions to a machine where known, or leave them
   explicitly Unknown/Ambiguous. Never use the first importer as silent fact.
7. Resolve configuration conflicts and publish the first Relaydot channel head.
   Conversation logs use append-aware import and preserve both divergent branches.
8. Apply the baseline to one canary machine, verify Claude/Codex can read their
   histories, and compare file counts/digests against the import report.
9. Apply to the remaining machines, then run two complete reconciliation cycles.
10. Disable and remove the Syncthing folder only after Relaydot reports every
   device consistent. Retain the pre-migration backup indefinitely under the
   current preservation policy.

## Machine identity

Each endpoint has an immutable cryptographic `device_id` and separate mutable
fields:

- `display_name`: operator-facing name, initially the hostname;
- `reported_hostname`: last OS hostname seen from the agent;
- labels/tags: arbitrary filters such as `desktop`, `laptop`, `work`, or `travel`;
- aliases: audited previous display names.

The device detail screen and device table allow editing `display_name` and labels.
Renaming changes the Relaydot label immediately and is sent to the agent on its next
check-in; it does not rename the operating system. Usage facts reference immutable
`device_id`, so history follows the machine across UI renames.

## Rollback

If canary validation fails, stop the Relaydot service, restore the per-machine
snapshot, and resume Syncthing with the original ignore file. Relaydot keeps import
objects isolated from the production channel until baseline publication, so a
failed import does not mutate a working machine.
