# WebKit on the Linux pool

Use the repository's normal pool submission route with this test command:

```sh
TEST_PORT=<dedicated-port> bunx playwright test \
  --config scripts/playwright-webkit-pool.config.ts \
  examples/look/tests/look.spec.ts
```

The pool configuration inherits the main configuration and its unchanged tests,
selects only WebKit, and supplies `LIBGL_ALWAYS_SOFTWARE=1` to the browser process.
It always starts its own server on the selected port. Chromium's configuration
is unchanged. This is a functional rendering check, not a hardware timing result.
Before test fixtures run, a global setup checks app-free page creation and
refuses a stall or rejection with `POOL_WEBKIT_NEWPAGE`, independently of the
enclosing test timeout. It records resolved package manifests, browser revision
metadata, executable hashes, and the runtime browser version on every invocation.

In issue #104's app-free control, launch and context creation succeeded but
`newPage()` stalled with zero requests. The browser reported
`ZINK: failed to choose pdev` and
`Could not create WPE EGL display: EGL_NOT_INITIALIZED`.
Forcing Mesa software rendering made page creation succeed under both Node and
Bun without installing system packages or modifying the pool image. The
automation-context warning also appeared in the successful control; that warning
alone is not a failure detector. The software setting is an observed workaround.
The EGL diagnostics do not establish which driver or device causes the stall,
or prove the setting alone is its root cause.

The minimal probe has no server, navigation, or application imports:

```sh
# Submit each command through the pool runner, never run browsers locally.
bun scripts/probe-webkit-newpage.ts --software
# Negative control: remove the process-local workaround.
env LIBGL_ALWAYS_SOFTWARE=0 bun scripts/probe-webkit-newpage.ts
```

The probe records the page-creation stage, elapsed milliseconds, request count,
and result. Its page-creation deadline is 10 seconds. A diagnostic job should
also bound the entire probe process, including browser shutdown, at 30 seconds.
An outer collector exit of zero does not turn a failed probe into a pass; read
each probe's exit and JSON result. Missing dependencies require a named refusal
and an image-owner handoff, not an automatic package installation.

The resolved `playwright-core@1.62.1` metadata used for issue #104 selects WebKit
revision `2336` with browser version `26.5`. A root-relative read of
`node_modules/playwright-core/browsers.json` is not valid with Bun's isolated
dependency layout; the probe resolves each dependency from its actual parent.
