#!/usr/bin/env bash
# Sandbox entrypoint: lint -> security scan -> execute -> structured JSON output
#
# Expects:
#   $SANDBOX_CODE_DIR/script.<ext>    -- the code to validate and run
#   $SANDBOX_CODE_DIR/metadata.json   -- {"language": "bash", "filename": "script.sh", "trivial": false}
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
TRIVIAL=$(jq -r '.trivial // false' "$METADATA")
CODE_FILE="$CODE_DIR/$FILENAME"

if [[ ! -f "$CODE_FILE" ]]; then
    echo "{\"error\":\"Code file not found: $FILENAME\",\"exit_code\":1}"
    exit 1
fi

# Warm pool: SANDBOX_WORK_DIR from warm_server (writable). Job path: /tmp/sandbox-work from image.
WORK_DIR="${SANDBOX_WORK_DIR:-/tmp/sandbox-work}"
mkdir -p "$WORK_DIR"
cp "$CODE_FILE" "$WORK_DIR/$FILENAME"
WORK_FILE="$WORK_DIR/$FILENAME"
chmod +x "$WORK_FILE" 2>/dev/null || true

LINT_OUTPUT=""
LINT_EXIT=0
SECURITY_OUTPUT=""
SECURITY_EXIT=0
EXEC_OUTPUT=""
EXEC_EXIT=0

# ---------------------------------------------------------------------------
# Language-specific linting
# Trivial: format/syntax only (avoids env-specific failures like go.mod, strict rules)
# Non-trivial: full lint
# ---------------------------------------------------------------------------
run_lint() {
    if [[ "$TRIVIAL" == "true" ]]; then
        case "$LANGUAGE" in
            bash|shell|sh)
                LINT_OUTPUT=$(bash -n "$WORK_FILE" 2>&1) || LINT_EXIT=$?
                ;;
            python)
                LINT_OUTPUT=$(python3 -m py_compile "$WORK_FILE" 2>&1) || LINT_EXIT=$?
                ;;
            javascript|typescript|js|ts)
                LINT_OUTPUT=$(node --check "$WORK_FILE" 2>&1) || LINT_EXIT=$?
                ;;
            c|cpp|c++)
                if [[ "$LANGUAGE" == "c" ]]; then
                    LINT_OUTPUT=$(gcc -fsyntax-only "$WORK_FILE" 2>&1) || LINT_EXIT=$?
                else
                    LINT_OUTPUT=$(g++ -fsyntax-only "$WORK_FILE" 2>&1) || LINT_EXIT=$?
                fi
                ;;
            java)
                LINT_OUTPUT=$(javac -Xlint:all "$WORK_FILE" 2>&1) || LINT_EXIT=$?
                ;;
            go)
                export GOCACHE="${WORK_DIR}/.gocache"
                export GOPATH="${WORK_DIR}/.gopath"
                mkdir -p "$GOCACHE" "$GOPATH"
                (cd "$WORK_DIR" && go mod init sandbox 2>/dev/null) || true
                LINT_OUTPUT=$(cd "$WORK_DIR" && go build -o /dev/null "./$FILENAME" 2>&1) || LINT_EXIT=$?
                ;;
            *)
                LINT_OUTPUT="No linter for trivial $LANGUAGE"
                LINT_EXIT=0
                ;;
        esac
    else
        case "$LANGUAGE" in
            bash|shell|sh)
                LINT_OUTPUT=$(shellcheck -f json "$WORK_FILE" 2>&1) || LINT_EXIT=$?
                ;;
            python)
                ruff check --fix "$WORK_FILE" >/dev/null 2>&1 || true
                LINT_OUTPUT=$(ruff check --output-format json "$WORK_FILE" 2>&1) || LINT_EXIT=$?
                ;;
            javascript|typescript|js|ts)
                eslint --fix "$WORK_FILE" >/dev/null 2>&1 || true
                LINT_OUTPUT=$(eslint --format json "$WORK_FILE" 2>&1) || LINT_EXIT=$?
                ;;
            c|cpp|c++)
                LINT_OUTPUT=$(cppcheck --enable=all --template='{file}:{line}: {severity}: {message}' "$WORK_FILE" 2>&1) || LINT_EXIT=$?
                ;;
            java)
                LINT_OUTPUT=$(javac -Xlint:all "$WORK_FILE" 2>&1) || LINT_EXIT=$?
                ;;
            go)
                export GOCACHE="${WORK_DIR}/.gocache"
                export GOPATH="${WORK_DIR}/.gopath"
                mkdir -p "$GOCACHE" "$GOPATH"
                (cd "$WORK_DIR" && go mod init sandbox 2>/dev/null) || true
                LINT_OUTPUT=$(cd "$WORK_DIR" && go vet "./$FILENAME" 2>&1) || LINT_EXIT=$?
                ;;
            *)
                LINT_OUTPUT="No linter configured for language: $LANGUAGE"
                LINT_EXIT=0
                ;;
        esac
    fi
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
        semgrep_out=$(semgrep --json --quiet "$rules_flag" "$WORK_FILE" 2>/dev/null) || true
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
# Code execution (trivial: full run; non-trivial: compile/check only, no run)
# Non-trivial snippets may lack full project context—verify they build, don't run.
# ---------------------------------------------------------------------------
run_execution() {
    # Trivial: we have a complete standalone program—run it
    if [[ "$TRIVIAL" == "true" ]]; then
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
                gcc -Wall -Wextra -o "$WORK_DIR/a.out" "$WORK_FILE" 2>&1 && \
                EXEC_OUTPUT=$(timeout 10s "$WORK_DIR/a.out" 2>&1) || EXEC_EXIT=$?
                ;;
            cpp|c++)
                g++ -Wall -Wextra -o "$WORK_DIR/a.out" "$WORK_FILE" 2>&1 && \
                EXEC_OUTPUT=$(timeout 10s "$WORK_DIR/a.out" 2>&1) || EXEC_EXIT=$?
                ;;
            java)
                EXEC_OUTPUT=$(timeout 10s java "$WORK_FILE" 2>&1) || EXEC_EXIT=$?
                ;;
            go)
                export GOCACHE="${WORK_DIR}/.gocache"
                export GOPATH="${WORK_DIR}/.gopath"
                mkdir -p "$GOCACHE" "$GOPATH"
                (cd "$WORK_DIR" && go mod init sandbox 2>/dev/null) || true
                EXEC_OUTPUT=$(cd "$WORK_DIR" && timeout 10s go run "./$FILENAME" 2>&1) || EXEC_EXIT=$?
                ;;
            *)
                EXEC_OUTPUT="No executor for trivial $LANGUAGE"
                EXEC_EXIT=1
                ;;
        esac
    else
        # Non-trivial: compile/parse check only—don't run (snippet may need full project)
        run_compile_check
    fi
}

run_compile_check() {
    case "$LANGUAGE" in
        bash|shell|sh)
            EXEC_OUTPUT=$(bash -n "$WORK_FILE" 2>&1) || EXEC_EXIT=$?
            [[ $EXEC_EXIT -eq 0 ]] && EXEC_OUTPUT="Syntax OK (non-trivial: run skipped)"
            ;;
        python)
            EXEC_OUTPUT=$(python3 -m py_compile "$WORK_FILE" 2>&1) || EXEC_EXIT=$?
            [[ $EXEC_EXIT -eq 0 ]] && EXEC_OUTPUT="Compile OK (non-trivial: run skipped)"
            ;;
        javascript|js|ts)
            EXEC_OUTPUT=$(node --check "$WORK_FILE" 2>&1) || EXEC_EXIT=$?
            [[ $EXEC_EXIT -eq 0 ]] && EXEC_OUTPUT="Parse OK (non-trivial: run skipped)"
            ;;
        c)
            EXEC_OUTPUT=$(gcc -fsyntax-only -o /dev/null "$WORK_FILE" 2>&1) || EXEC_EXIT=$?
            [[ $EXEC_EXIT -eq 0 ]] && EXEC_OUTPUT="Compile OK (non-trivial: run skipped)"
            ;;
        cpp|c++)
            EXEC_OUTPUT=$(g++ -fsyntax-only -o /dev/null "$WORK_FILE" 2>&1) || EXEC_EXIT=$?
            [[ $EXEC_EXIT -eq 0 ]] && EXEC_OUTPUT="Compile OK (non-trivial: run skipped)"
            ;;
        java)
            EXEC_OUTPUT=$(javac -Xlint:all "$WORK_FILE" 2>&1) || EXEC_EXIT=$?
            [[ $EXEC_EXIT -eq 0 ]] && EXEC_OUTPUT="Compile OK (non-trivial: run skipped)"
            ;;
        go)
            export GOCACHE="${WORK_DIR}/.gocache"
            export GOPATH="${WORK_DIR}/.gopath"
            mkdir -p "$GOCACHE" "$GOPATH"
            (cd "$WORK_DIR" && go mod init sandbox 2>/dev/null) || true
            EXEC_OUTPUT=$(cd "$WORK_DIR" && go build -o /dev/null "./$FILENAME" 2>&1) || EXEC_EXIT=$?
            [[ $EXEC_EXIT -eq 0 ]] && EXEC_OUTPUT="Build OK (non-trivial: run skipped)"
            ;;
        *)
            EXEC_OUTPUT="No compile check for $LANGUAGE"
            EXEC_EXIT=0
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

EXEC_ATTEMPTED=false
EXEC_SKIP_REASON=""
if [[ "$LINT_PASSED" == "true" && "$SECURITY_PASSED" == "true" ]]; then
    run_execution
    EXEC_ATTEMPTED=true
else
    EXEC_OUTPUT="Skipped: lint or security checks failed"
    EXEC_EXIT=1
    [[ "$LINT_PASSED" != "true" ]] && EXEC_SKIP_REASON="lint_failed"
    [[ "$SECURITY_PASSED" != "true" && -z "$EXEC_SKIP_REASON" ]] && EXEC_SKIP_REASON="security_failed"
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
    --argjson exec_attempted "$EXEC_ATTEMPTED" \
    --arg exec_skip_reason "$EXEC_SKIP_REASON" \
    --argjson exit_code "$OVERALL_EXIT" \
    '{
        language: $language,
        lint: { output: $lint_output, exit_code: $lint_exit, passed: $lint_passed },
        security: { output: $security, exit_code: $security_exit, passed: $security_passed },
        execution: { output: $exec_output, exit_code: $exec_exit, attempted: $exec_attempted, skip_reason: (if $exec_skip_reason != "" then $exec_skip_reason else null end) },
        exit_code: $exit_code
    }'

exit $OVERALL_EXIT
