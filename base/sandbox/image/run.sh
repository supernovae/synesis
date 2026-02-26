#!/usr/bin/env bash
# Sandbox entrypoint: lint -> security scan -> execute -> structured JSON output
#
# Expects:
#   $SANDBOX_CODE_DIR/script.<ext>    -- the code to validate and run
#   $SANDBOX_CODE_DIR/metadata.json   -- {"language": "bash", "filename": "script.sh"}
#
# SANDBOX_CODE_DIR defaults to /sandbox/code (ConfigMap mount for Job path).
# The warm pool server overrides this to a per-request temp directory.
#
# Outputs structured JSON to stdout for the executor node to parse.

set -uo pipefail

CODE_DIR="${SANDBOX_CODE_DIR:-/sandbox/code}"

METADATA="$CODE_DIR/metadata.json"
if [[ ! -f "$METADATA" ]]; then
    echo '{"error":"metadata.json not found","exit_code":1}'
    exit 1
fi

LANGUAGE=$(jq -r '.language // "bash"' "$METADATA")
FILENAME=$(jq -r '.filename // "script.sh"' "$METADATA")
CODE_FILE="$CODE_DIR/$FILENAME"

if [[ ! -f "$CODE_FILE" ]]; then
    echo "{\"error\":\"Code file not found: $FILENAME\",\"exit_code\":1}"
    exit 1
fi

cp "$CODE_FILE" "/tmp/sandbox-work/$FILENAME"
WORK_FILE="/tmp/sandbox-work/$FILENAME"
chmod +x "$WORK_FILE" 2>/dev/null || true

LINT_OUTPUT=""
LINT_EXIT=0
SECURITY_OUTPUT=""
SECURITY_EXIT=0
EXEC_OUTPUT=""
EXEC_EXIT=0

# ---------------------------------------------------------------------------
# Language-specific linting
# ---------------------------------------------------------------------------
run_lint() {
    case "$LANGUAGE" in
        bash|shell|sh)
            LINT_OUTPUT=$(shellcheck -f json "$WORK_FILE" 2>&1) || LINT_EXIT=$?
            ;;
        python)
            LINT_OUTPUT=$(ruff check --output-format json "$WORK_FILE" 2>&1) || LINT_EXIT=$?
            ;;
        javascript|typescript|js|ts)
            LINT_OUTPUT=$(eslint --format json "$WORK_FILE" 2>&1) || LINT_EXIT=$?
            ;;
        c|cpp|c++)
            LINT_OUTPUT=$(cppcheck --enable=all --template='{file}:{line}: {severity}: {message}' "$WORK_FILE" 2>&1) || LINT_EXIT=$?
            ;;
        java)
            LINT_OUTPUT=$(javac -Xlint:all "$WORK_FILE" 2>&1) || LINT_EXIT=$?
            ;;
        go)
            LINT_OUTPUT=$(go vet "$WORK_FILE" 2>&1) || LINT_EXIT=$?
            ;;
        *)
            LINT_OUTPUT="No linter configured for language: $LANGUAGE"
            LINT_EXIT=0
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Security scanning (semgrep + language-specific)
# ---------------------------------------------------------------------------
run_security() {
    local semgrep_out=""
    local bandit_out=""

    if command -v semgrep &>/dev/null; then
        local rules_flag=""
        if [[ -d /sandbox/semgrep-rules ]] && ls /sandbox/semgrep-rules/*.yaml &>/dev/null 2>&1; then
            rules_flag="--config /sandbox/semgrep-rules/"
        else
            rules_flag="--config auto"
        fi
        semgrep_out=$(semgrep --json --quiet $rules_flag "$WORK_FILE" 2>/dev/null) || true
    fi

    case "$LANGUAGE" in
        python)
            if command -v bandit &>/dev/null; then
                bandit_out=$(bandit -f json "$WORK_FILE" 2>/dev/null) || true
            fi
            ;;
    esac

    SECURITY_OUTPUT=$(jq -n \
        --arg semgrep "$semgrep_out" \
        --arg bandit "$bandit_out" \
        '{semgrep: ($semgrep | try fromjson // $semgrep), bandit: ($bandit | try fromjson // $bandit)}')

    if echo "$semgrep_out" | jq -e '.results | length > 0' &>/dev/null 2>&1; then
        SECURITY_EXIT=1
    fi
    if echo "$bandit_out" | jq -e '.results | length > 0' &>/dev/null 2>&1; then
        SECURITY_EXIT=1
    fi
}

# ---------------------------------------------------------------------------
# Code execution (only if lint + security pass)
# ---------------------------------------------------------------------------
run_execution() {
    case "$LANGUAGE" in
        bash|shell|sh)
            EXEC_OUTPUT=$(timeout 10s bash "$WORK_FILE" 2>&1) || EXEC_EXIT=$?
            ;;
        python)
            EXEC_OUTPUT=$(timeout 10s python3 "$WORK_FILE" 2>&1) || EXEC_EXIT=$?
            ;;
        javascript|js)
            EXEC_OUTPUT=$(timeout 10s node "$WORK_FILE" 2>&1) || EXEC_EXIT=$?
            ;;
        c)
            gcc -Wall -Wextra -o /tmp/sandbox-work/a.out "$WORK_FILE" 2>&1 && \
            EXEC_OUTPUT=$(timeout 10s /tmp/sandbox-work/a.out 2>&1) || EXEC_EXIT=$?
            ;;
        cpp|c++)
            g++ -Wall -Wextra -o /tmp/sandbox-work/a.out "$WORK_FILE" 2>&1 && \
            EXEC_OUTPUT=$(timeout 10s /tmp/sandbox-work/a.out 2>&1) || EXEC_EXIT=$?
            ;;
        java)
            EXEC_OUTPUT=$(timeout 10s java "$WORK_FILE" 2>&1) || EXEC_EXIT=$?
            ;;
        go)
            EXEC_OUTPUT=$(timeout 10s go run "$WORK_FILE" 2>&1) || EXEC_EXIT=$?
            ;;
        *)
            EXEC_OUTPUT="No executor configured for language: $LANGUAGE"
            EXEC_EXIT=1
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Run pipeline
# ---------------------------------------------------------------------------
run_lint
run_security

LINT_PASSED=true
SECURITY_PASSED=true
[[ $LINT_EXIT -ne 0 ]] && LINT_PASSED=false
[[ $SECURITY_EXIT -ne 0 ]] && SECURITY_PASSED=false

if [[ "$LINT_PASSED" == "true" && "$SECURITY_PASSED" == "true" ]]; then
    run_execution
else
    EXEC_OUTPUT="Skipped: lint or security checks failed"
    EXEC_EXIT=1
fi

OVERALL_EXIT=0
[[ $LINT_EXIT -ne 0 || $SECURITY_EXIT -ne 0 || $EXEC_EXIT -ne 0 ]] && OVERALL_EXIT=1

# Truncate outputs to prevent excessive log sizes
truncate_output() {
    local input="$1"
    local max_len=4096
    if [[ ${#input} -gt $max_len ]]; then
        echo "${input:0:$max_len}... [truncated]"
    else
        echo "$input"
    fi
}

LINT_OUTPUT=$(truncate_output "$LINT_OUTPUT")
EXEC_OUTPUT=$(truncate_output "$EXEC_OUTPUT")

jq -n \
    --arg language "$LANGUAGE" \
    --arg lint_output "$LINT_OUTPUT" \
    --argjson lint_exit "$LINT_EXIT" \
    --argjson lint_passed "$LINT_PASSED" \
    --argjson security "$SECURITY_OUTPUT" \
    --argjson security_exit "$SECURITY_EXIT" \
    --argjson security_passed "$SECURITY_PASSED" \
    --arg exec_output "$EXEC_OUTPUT" \
    --argjson exec_exit "$EXEC_EXIT" \
    --argjson exit_code "$OVERALL_EXIT" \
    '{
        language: $language,
        lint: { output: $lint_output, exit_code: $lint_exit, passed: $lint_passed },
        security: { output: $security, exit_code: $security_exit, passed: $security_passed },
        execution: { output: $exec_output, exit_code: $exec_exit },
        exit_code: $exit_code
    }'

exit $OVERALL_EXIT
