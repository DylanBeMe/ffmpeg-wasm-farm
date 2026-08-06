# Releasing

The repository has two GitHub Actions workflows:

- `CI` runs on pushes, pull requests, and manual dispatch. It tests Node.js 20, 22, and 24; builds the demo; runs the native FFmpeg smoke test; and uploads the generated npm tarball.
- `Release` runs when a version tag such as `v0.2.1` is pushed. It repeats the typechecks, tests, production demo build, native FFmpeg smoke test, and package validation; publishes to npm through OIDC trusted publishing; and creates a GitHub Release containing the same tarball.

## One-time setup

1. Create a GitHub environment named `npm`. Add required reviewers if releases should need manual approval.
2. In the package settings on npmjs.com, configure a GitHub Actions trusted publisher with:
   - the GitHub organization or username;
   - the repository name;
   - workflow filename `release.yml`;
   - environment name `npm`;
   - allowed action `npm publish`.
3. Protect the default branch and require the `CI` checks before merging. Protect release tags such as `v*` so only maintainers can create them.
4. After the first successful trusted publish, consider configuring npm publishing access to require two-factor authentication and disallow traditional tokens.

No long-lived npm publish token is required. The release job requests a short-lived OIDC identity using `id-token: write`.

## Publish a release

Make sure the working tree is clean and CI is green, then update the version and push the generated commit and tag:

```bash
npm version patch   # or minor / major / 0.3.0-beta.1
git push --follow-tags
```

The tag must exactly equal `v` plus the version in `package.json`. Stable versions publish under npm's `latest` dist-tag; prerelease versions publish under `next`.

A rerun is safe: the workflow skips npm publication when that exact package version already exists, then creates or updates the GitHub Release asset.

## Dependency lockfile

The workflows prefer `npm ci` when `package-lock.json` exists. Until a lockfile is committed, they fall back to `npm install` and emit a warning. Commit a lockfile from an environment that can reach all declared FFmpeg packages to make installs fully reproducible.
