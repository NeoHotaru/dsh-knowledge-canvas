# Issue #11 · clean official host startup

Status: released as 0.4.5 on 2026-10-23 (America/Los_Angeles). PR #12 merged as e9b5cca19fe44ab7d6f719b9afbacbb85d8f62e4. Source baseline: 22230ce (0.4.4).

GitHub Release: https://github.com/NeoHotaru/dsh-knowledge-canvas/releases/tag/v0.4.5

npm latest was verified as 0.4.5. Published tarball SHA-1: `db133e98d281b3de1aabf0462806f63bbd2baf21`. Downloaded `client.js`, `index.js`, `cordis.patch.yml` and `package.json` match release source byte-for-byte. All eight PR/push checks and the four merged-main checks passed (Windows/Linux × Node22/24). Issue #11 was closed by the merged PR and received the release/upgrade explanation: https://github.com/NeoHotaru/dsh-knowledge-canvas/issues/11#issuecomment-6381122220

Issue: https://github.com/NeoHotaru/dsh-knowledge-canvas/issues/11

## Cause

The official client-module graph uses the resolved npm package name, `dsh-knowledge-canvas`. Our client script registered a factory under `dsh-knowledge-tree`. The initial combo script therefore ran without satisfying the requested graph entry. The host retried the standalone client script, which registered the old factory a second time and threw. Ignoring duplicates would still leave the requested graph entry missing.

Only the client factory registration changes. Cordis entry id, backend export name, panel contribution ids, `knowledge-tree` tab kind, `/dsh-knowledge-tree` HTTP routes and `.dsh-knowledge/` storage stay unchanged. No migration or extra model call is involved.

## Environment and results

Windows x64, Node 24.19.0, pnpm 12.6.0, official `@deepseek-ai/dsh@0.2.1-rc.2`, separate headless Chrome. No model credentials configured or model requests sent. The tested host and dependencies were installed afresh, rather than linked from the author's customized DSH.

| Case | Result |
| --- | --- |
| Official base/web only | Normal home screen, zero page errors |
| npm 0.4.2 installed but not in bundles | Normal home screen, zero page errors |
| npm 0.4.2 enabled once | Boot failure and duplicate old factory, matching issue #11 |
| npm 0.4.4 enabled once | Same boot failure |
| Local fixed tarball installed into failing 0.4.2 profile | Boot succeeds; cold restart succeeds |
| Fixed tarball in a new profile and explicit isolated Documents directory | First boot succeeds; welcome library and tutorial nodes visible |
| Same new profile after cold host restart | Boot and panel succeed; knowledge files byte-identical |
| `npm run check:all` | All checks and suites pass; storage suite 537 passed, 0 failed |

The initial sandbox test encountered EPERM on a temporary-file rename; a normal-permission full rerun passed. This was not counted as a plugin assertion failure.

Reporter uses Electron 44.7.0 / Node 24.21.0. This experiment reproduces the exact error through the official web frontend/module loader, **not the Electron desktop startup wrapper**. Do not describe it as desktop validation.

## Reproduction boundaries

Local test workspace: `D:/codex-work/dsh-clean-room`. `run-isolated.py` supplies a separate DSH_HOME and removes inherited provider keys. Install the official CLI, then create a web profile containing only base, web-app and the exact npm plugin. Use `pnpm install --ignore-scripts` and start `web --no-open --host 127.0.0.1 --port <test-port>`.

For a completely isolated workspace as well as configuration, add this profile patch **before first launch**:

```yaml
- id: workspace-controller
  config:
    documentsDirectory: D:/codex-work/dsh-clean-room/homes/fixed-fresh/documents
```

DSH_HOME alone does not relocate the official system Documents default workspace. Earlier panel probes generated welcome data in the system Documents default directory; those files were preserved. The final fresh-install/restart test explicitly isolates both locations and asserts every workspace path is beneath the test home.

Browser probes use the normal test login URL/cookies, then visit the same profile again after host restart. `inspect-panel.mjs` opens the knowledge tab and asserts tutorial content and zero page errors. `snapshot-fresh.py` compares knowledge file SHA-256 values across restart. Do not publish cookies or local login tokens.

Raw local evidence is under `D:/codex-work/dsh-clean-room/evidence/`: `canvas042-enabled`, `canvas044-published-auth`, `canvas-fixed-first`, `canvas-fixed-restart`, `fixed-fresh-first`, `fixed-fresh-restart`, `fixed-fresh-panel-restart`, the two `fixed-fresh-data-*-restart.json` manifests and `check-all.log`. Selected sanitized reports are copied beside this document.

## Regression protection

The bundle contract validates the shipped source registration against package.json. A mutant restoring the old factory id must fail independently of patch-name and eager-loading defects. The packed-install test resolves by published name and asserts the expected factory exists while legacy data/route/tab identifiers remain stable. The load check derives its expected module id from package.json instead of hard-coding the historical wrong name.

These automated tests cover the naming contract and client application. They do not replace the clean-host browser experiment above.
