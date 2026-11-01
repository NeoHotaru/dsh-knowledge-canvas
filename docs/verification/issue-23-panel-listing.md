# Issue #23: attachment preferences must not break the panel

Released: 0.4.6, 2026-11-01.

## Reproduction and fix

Changing attachment reading mode calls `writeAttachmentMode`, creating `.dsh-knowledge/.attachment-settings.json` without a base `id`. In 0.4.5 the panel read it as a base and called `parsed.id.startsWith`, failing the entire panel. The host store already excluded the file, explaining why model-side reads continued working.

The client now skips that preferences filename and guards other parsed values before treating their ID as a string. It still reads `selection.json` and `layout.json` to restore enabled bases, ordering and layout. No knowledge data migration or preference deletion is necessary.

## Regression coverage

`test-panel-listing.mjs` extracts and runs the client's actual async loading effect with temporary filesystem-backed workspace-file services. The test deterministically failed against 0.4.5 with the reported `startsWith` error, then passed with the fix.

It covers actual `writeAttachmentMode` writes for `on-demand` and `required`, an invalid JSON attachment preferences file that must never be read by this path, preferences misleadingly containing an ID, unrelated parsed values without string IDs, selection/order/layout restoration, diary filtering, and preservation of base file contents. It is included in `npm test`.

## Browser supplement

`issue-23-evidence/browser-results.json` records actual React component rendering in headless Chrome for both policies. The knowledge base and its node open successfully, with zero page script errors. The fixture uses synthetic knowledge data and mocked host file/HTTP services. It does not claim full Electron desktop integration or an end-user environment reproduction.

Screenshots:

- [On demand](issue-23-evidence/panel-on-demand.png)
- [Required](issue-23-evidence/panel-required.png)

## Limits

This is a client listing fix. It adds no model requests and changes no injection policies. Other malformed JSON syntax still follows the existing load-error path. Tests that write preferences need normal filesystem rename permissions on Windows; a sandbox EPERM is not a code regression.

## Published package

[PR #24](https://github.com/NeoHotaru/dsh-knowledge-canvas/pull/24) merged as `ef3fcf08997a2c31cc919b3a1b1bc28b5a1ff8ba`. All four Windows/Linux and Node 22/24 CI combinations passed for the PR and merged commit. The [0.4.6 release](https://github.com/NeoHotaru/dsh-knowledge-canvas/releases/tag/v0.4.6) includes the tested tarball.

The public npm registry reports `latest=0.4.6`. Its downloaded tarball matches the local pack integrity, and `client.js`, `package.json`, `CHANGELOG.md`, and `cordis.patch.yml` match the tested source byte for byte. See [registry verification](issue-23-evidence/registry-046-verified.json). [Issue #23](https://github.com/NeoHotaru/dsh-knowledge-canvas/issues/23) was replied to and closed after this verification.
