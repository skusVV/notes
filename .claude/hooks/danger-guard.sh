#!/usr/bin/env bash
# PreToolUse(Bash) guard against destructive commands, for the main session and every agent.
#
# The spec pipeline pushes to main with no human in the loop, so the dangerous commands are
# stopped here, in the harness, rather than trusted to each agent's judgement.
#   deny: rewriting or deleting main, printing a secret value
#   ask:  GCP deletes and access (IAM) changes - the owner decides each one
# Everything else passes untouched. Tool-call JSON arrives on stdin.

cmd="$(cat | jq -r '.tool_input.command // ""')"

decide() {
  jq -n --arg d "$1" --arg r "$2" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
  exit 0
}

has() { printf '%s' "$cmd" | grep -qE -- "$1"; }

# --- git: main is only ever fast-forwarded and pushed normally -------------------------------
# Checked per subcommand (split on && || ; |), so `git reset --hard main && git push --force origin
# testing` - the verifier's own lane reset - is not mistaken for a force-push of main.
while IFS= read -r seg || [ -n "$seg" ]; do
  printf '%s' "$seg" | grep -qE '(^|[[:space:]])git[[:space:]]+push([[:space:]]|$)' || continue
  # The refspecs: every word after `push` that is not an option, minus the remote name.
  refs="$(printf '%s' "$seg" | sed -E 's/.*git[[:space:]]+push//' | tr ' ' '\n' | grep -vE '^(-|$)' | tail -n +2)"
  targets_main=false
  printf '%s\n' "$refs" | grep -qE '^\+?([^:]*:)?(refs/heads/)?(main|master)$' && targets_main=true
  if printf '%s' "$seg" | grep -qE '[[:space:]](-f|--force|--force-with-lease)([[:space:]=]|$)|[[:space:]]\+[^[:space:]]' && $targets_main; then
    decide deny "danger-guard: force-pushing main is not allowed. Only the testing branch may be force-pushed."
  fi
  if printf '%s' "$seg" | grep -qE '[[:space:]](--delete|-d)([[:space:]]|$)' || printf '%s\n' "$refs" | grep -qE '^:'; then
    decide deny "danger-guard: deleting a remote branch is not allowed from here."
  fi
  if printf '%s' "$seg" | grep -qE '[[:space:]](--mirror|--all)([[:space:]]|$)'; then
    decide deny "danger-guard: mirror/all pushes are not allowed."
  fi
done < <(printf '%s' "$cmd" | sed -E 's/(&&|\|\||;|\|)/\n/g')

if has '(^|[;&|( ])git[[:space:]]+branch[[:space:]]+(-D|-d|--delete)[[:space:]]+(main|master)([[:space:]]|$)'; then
  decide deny "danger-guard: deleting main is not allowed."
fi

# --- GCP CLI -----------------------------------------------------------------------------------
if has '(^|[;&|( ])(gcloud|gsutil|bq)[[:space:]]'; then
  if has 'secrets[[:space:]]+versions[[:space:]]+access'; then
    decide deny "danger-guard: printing a secret value is not allowed."
  fi
  if has '(add-iam-policy-binding|remove-iam-policy-binding|set-iam-policy)' || has 'iam[[:space:]]+service-accounts[[:space:]]+(create|delete|keys)'; then
    decide ask "danger-guard: this changes access (IAM). The owner approves each one."
  fi
  if has '[[:space:]](delete|rm|rb)([[:space:]]|$)' || has '[[:space:]]-r[[:space:]]'; then
    decide ask "danger-guard: this deletes something in GCP. The owner approves each one."
  fi
fi

# --- local filesystem: never wipe the repo or home ---------------------------------------------
if has 'rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)[[:space:]]+(/|~|\$HOME|\.|\./|\.\.|/Users/[^/ ]+/?)([[:space:]]|$)'; then
  decide deny "danger-guard: refusing to recursively delete /, home or the repository root."
fi

exit 0
