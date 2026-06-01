# Branch protection setup — `main`

Branch protection on `main` enforces code-review and CI-pass requirements before any change lands. This is a one-time configuration in the GitHub UI (or via the API if you have a token).

## Quick setup via UI (5 minutes)

1. Open https://github.com/imronzuhri-svg/hara-registry/settings/branches
2. Click **"Add classic branch protection rule"** (or "Add rule" depending on UI version)
3. **Branch name pattern**: `main`
4. Enable the following:

   ### Required settings (recommended for a serious project)

   - [x] **Require a pull request before merging**
     - [x] Require approvals: **1** (raise to 2 once you have multiple maintainers)
     - [x] Dismiss stale pull request approvals when new commits are pushed
     - [ ] Require review from Code Owners (only if you add a `CODEOWNERS` file later)

   - [x] **Require status checks to pass before merging**
     - [x] Require branches to be up to date before merging
     - **Status checks** to require (after the first CI run populates them):
       - `forge build + test` (from `contracts.yml`)
       - `typecheck + build` (from `services.yml`)
       - `Analyze javascript-typescript` (from `codeql.yml`)
       - `Slither static analysis` (from `slither.yml`)
       - `Gitleaks` (from `secret-scan.yml`)

   - [x] **Require conversation resolution before merging**
   - [x] **Require signed commits** (optional but recommended — set up GPG/SSH signing if not already)
   - [x] **Require linear history** (forces rebase-merge or squash-merge; no merge commits)

   ### Hard guards

   - [x] **Do not allow bypassing the above settings** (even repo admins, including you)
   - [x] **Restrict who can push to matching branches**: empty list (no direct pushes; all changes via PR)
   - [x] **Allow force pushes**: **No**
   - [x] **Allow deletions**: **No**

5. Click **"Create"** at the bottom.

## What "Restrict who can push" should look like

Empty list. **Nobody pushes to main directly** — even you. Every change becomes a PR + review + CI-pass. Cumbersome at first; saves you when a bad commit would have nuked the chain.

If you absolutely need to bypass for an emergency, GitHub lets repo admins temporarily disable the rule. Re-enable immediately after.

## Status checks won't be available until first CI run

Branch protection can only "require" status checks that GitHub has seen at least once. The flow is:

1. Push the CI workflow files to `main` (we just did this — see `.github/workflows/*.yml`).
2. Wait for the first push to trigger a workflow run.
3. Workflows complete (or fail) — GitHub records the check names.
4. **Then** go to branch protection settings; the check names appear in the dropdown.
5. Select the ones you want as required.

Until step 4, branch protection works but doesn't enforce CI.

## Quick setup via CLI (alternative)

If you've installed `gh` CLI later, you can set the entire policy with one command:

```bash
gh api -X PUT "repos/imronzuhri-svg/hara-registry/branches/main/protection" \
  -F required_status_checks='{"strict":true,"contexts":["forge build + test","typecheck + build"]}' \
  -F enforce_admins=true \
  -F required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true}' \
  -F restrictions=null \
  -F allow_force_pushes=false \
  -F allow_deletions=false \
  -F required_conversation_resolution=true \
  -F required_linear_history=true
```

## Optional: ruleset (newer GitHub API, more powerful)

GitHub Rulesets are a successor to classic branch protection — same intent, more flexibility (target multiple branches with one rule, layer multiple rules, etc.). For our single-branch case, classic protection is enough. Migrate later if you want.

## After enabling

Test it works:
1. `git checkout -b test/protection`
2. `git commit --allow-empty -m "test branch protection"`
3. `git push origin test/protection`
4. Open a PR on GitHub. Confirm:
   - "Reviewers required" badge
   - CI checks running
   - Cannot merge until both green + reviewed
5. Close the test PR + delete the branch.

## Recommended additional repo settings (Settings → General)

- [ ] **Allow merge commits**: OFF — forces clean linear history
- [ ] **Allow squash merging**: ON (default), require PR title as the commit message
- [ ] **Allow rebase merging**: ON (alternative to squash for small PRs)
- [x] **Automatically delete head branches** after PR merge

Combined with the linear-history rule, this gives you a clean, scannable `git log` on `main`.
