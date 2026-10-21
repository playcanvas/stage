# Contributing

Contributions should improve how you and your agent work on PlayCanvas apps in Stage, or fix a bug in it. Open an
issue first for a new tool, skill or viewer feature so the scope can be agreed before implementation.

## Changes

- The plugin lives in `plugins/playcanvas-stage/`; see its [README](plugins/playcanvas-stage/README.md) for the
  layout and the trust boundaries every change must keep.
- The plugin has no runtime dependencies: Node runs the `.ts` sources directly. Keep it that way; development
  dependencies stay in the root `package.json`.
- Keep the tool contracts in step with Claude Code's Artifact tools they are modelled on, and record any local
  difference in the plugin README.
- Keep the Claude and Codex manifests, both marketplaces and the README in step when adding or renaming a skill or
  tool, and update the token counts in the README.
- Add the smallest repeatable test for non-trivial behavior. Viewer and live-app changes are tested in headless
  Chrome under `test/`, outside the shipped plugin.

## Checks

```bash
npm install
npm test
npm run typecheck
npm run lint
```

The tests need Chrome or Chromium (`CHROME_PATH` points at one that isn't found). `npm run lint:fix` applies
[`@playcanvas/eslint-config`](https://github.com/playcanvas/eslint-config) and its Prettier house style. To run a
working copy instead of the installed plugin, point the `stage` MCP server at `plugins/playcanvas-stage/server/mcp.ts`
in a local `.mcp.json` (Claude Code) or `.codex/config.toml` (Codex); both are git-ignored.

Validate the plugin and marketplace before opening a pull request:

```bash
claude plugin validate plugins/playcanvas-stage --strict
claude plugin validate . --strict
```

Pull requests should explain the user-visible failure or workflow being improved and include numbered manual
smoke-test steps with expected results when runtime behavior changes.

## Releases

Run the **Publish** workflow from `main` in GitHub Actions and choose `patch`, `minor`, or `major`. It bumps the
version in both plugin manifests and both marketplaces, pushes the release commit and tag together, and creates the
GitHub release with install steps and the merged pull requests since the last tag. `0.x` releases are marked as
prereleases. The first release is `minor`, from `0.0.0` to `v0.1.0`.
