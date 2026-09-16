#!/usr/bin/env bash
# PreToolUse(Bash) guard for GCP CLI calls.
#
# Determinism lives in .claude/settings.local.json (env CLOUDSDK_CORE_PROJECT and
# CLOUDSDK_CORE_ACCOUNT), which gcloud/gsutil/bq read natively. This hook is the
# tripwire: it refuses a GCP CLI command when a pin is missing, or when the command
# overrides the pin to a different project or account. Tool-call JSON arrives on stdin.

cmd="$(cat | jq -r '.tool_input.command // ""')"

# Only guard GCP CLI invocations; everything else passes untouched.
if ! printf '%s' "$cmd" | grep -qE '(^|[;&|(]| )(gcloud|gsutil|bq)([[:space:]]|$)'; then
  exit 0
fi

deny() {
  jq -n --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

exp_project="${CLOUDSDK_CORE_PROJECT:-}"
exp_account="${CLOUDSDK_CORE_ACCOUNT:-}"

[ -n "$exp_project" ] || deny "GCP guard: CLOUDSDK_CORE_PROJECT is unset. Set it in .claude/settings.local.json (then reload with /hooks) before running any gcloud command."
[ -n "$exp_account" ] || deny "GCP guard: CLOUDSDK_CORE_ACCOUNT is unset. Set it in .claude/settings.local.json before running any gcloud command."

# Refuse an explicit override to a different project or account.
proj="$(printf '%s' "$cmd" | grep -oE -- '--project[= ][^ ]+' | head -1 | sed -E 's/^--project[= ]//')"
[ -z "$proj" ] || [ "$proj" = "$exp_project" ] || deny "GCP guard: command targets --project=$proj, but only $exp_project is allowed here. Drop the flag (the env already pins it) or fix the value."

acct="$(printf '%s' "$cmd" | grep -oE -- '--account[= ][^ ]+' | head -1 | sed -E 's/^--account[= ]//')"
[ -z "$acct" ] || [ "$acct" = "$exp_account" ] || deny "GCP guard: command targets --account=$acct, but only $exp_account is allowed here."

exit 0
