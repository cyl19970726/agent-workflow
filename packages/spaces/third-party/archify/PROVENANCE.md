# Archify viewer subset

Source: [tt-a1i/archify](https://github.com/tt-a1i/archify), version 3.0.1, pinned commit `73aaa0696e8f72c232ea710e6fa94fd953f3e773`.

This directory contains only the workflow compiler, its runtime dependencies, and the self-contained viewer template. `LICENSE` preserves Archify's MIT notice; `THIRD_PARTY_NOTICES.md` and `assets/JetBrainsMono-OFL.txt` preserve third-party and bundled-font notices. No global skill or installer is used. The generated brand-mark module is an upstream compiler dependency; this adapter does not request brand marks.

`UPSTREAM.json` records the original SHA-256 for every imported file, verified against the pinned source archive. `integration.patch` records the local differences:

- Extend fill, text and sigil mappings with actual workflow executor categories. Infrastructure kinds are not used as displayed substitutes.
- Validate extended workflow categories with an infrastructure-type projection only inside the upstream schema validator; all other strict IR validation stays intact.
- Increase preferred node text sizes for a workbench embedded diagram; upstream fitting and minimum sizes remain active.

The host adapter outside this directory supplies deterministic process topology and presentation labels, Chinese UI, type/status metadata, disabled automatic flow animation, and a bounded node-selection bridge. It serves the viewer in an authenticated sandboxed iframe. These are local integration capabilities, not claims about upstream's public API.

To update upstream, compare the pinned archive to `UPSTREAM.json`, reapply and review `integration.patch`, run renderer/HTTP tests, and inspect a real CONTENT diagram in the browser. Build copies this directory into `dist/third-party/archify`; package distribution includes the licenses with the runtime.
