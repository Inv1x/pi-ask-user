---
"@inv1x/pi-ask-user": minor
---

Raise the minimum supported Pi version to 1.4.0 and pin the development SDK and lockfile to that release. Older Pi hosts are no longer supported. This baseline includes the host fix for concurrent extension dialogs leaving promises unresolved. Update real-runner tests to use Pi's tool execution context and check the installed Pi dependency tree in CI.
