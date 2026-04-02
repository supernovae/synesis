/**
 * Deterministic enrichment for validation findings.
 *
 * For each finding, this module:
 *   1. Classifies the error into a known family (e.g. "type_mismatch")
 *   2. Adds a deterministic root cause explanation
 *   3. Adds a deterministic suggested next action (file-aware when possible)
 *   4. Computes a content-addressable fingerprint for dedup
 *   5. Marks repeat findings
 *
 * All logic is mechanical — no LLM calls. If a finding can't be classified,
 * the enrichment fields are left undefined and the model fills the gap.
 */
import crypto from "node:crypto";
import { getLanguagePackRegistry } from "../language-packs/index.js";
/* ── Public API ────────────────────────────────────────────────── */
export function enrichFindings(findings) {
    const enriched = findings.map((f) => {
        const errorFamily = classifyErrorFamily(f.family, f.message, f.ruleId);
        const rootCause = errorFamily ? getRootCause(f.family, errorFamily) : undefined;
        const action = errorFamily ? getNextAction(f.family, errorFamily, f.file) : undefined;
        const fp = computeFingerprint(f);
        return {
            ...f,
            errorFamily: errorFamily ?? f.errorFamily,
            likelyRootCause: rootCause ?? f.likelyRootCause,
            suggestedNextAction: action ?? f.suggestedNextAction,
            likelyFix: action ?? f.likelyFix,
            rawFingerprint: fp
        };
    });
    return markRepeats(enriched);
}
/* ── Fingerprinting ────────────────────────────────────────────── */
function computeFingerprint(f) {
    const seed = `${f.file ?? ""}:${f.line ?? 0}:${f.message}`;
    return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 12);
}
function markRepeats(findings) {
    const seen = new Set();
    return findings.map((f) => {
        const key = `${f.errorFamily ?? ""}:${f.file ?? ""}:${f.message}`;
        const fp = crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
        if (seen.has(fp)) {
            return { ...f, isRepeat: true };
        }
        seen.add(fp);
        return f;
    });
}
/* ── Master dispatcher ─────────────────────────────────────────── */
export function classifyErrorFamily(family, message, ruleId) {
    switch (family) {
        case "typescript": return classifyTypescript(message);
        case "eslint": return classifyEslint(message, ruleId);
        case "ruff": return classifyRuff(message, ruleId);
        case "pytest": return classifyPytest(message);
        case "mypy": return classifyMypy(message, ruleId);
        case "pylint": return classifyPylint(message, ruleId);
        case "terraform": return classifyTerraform(message);
        case "cargo": return classifyCargo(message, ruleId);
        case "golangci-lint": return classifyGolangci(message, ruleId);
        case "tfsec": return classifySecurity(message, ruleId);
        case "trivy": return classifySecurity(message, ruleId);
        case "semgrep": return classifySecurity(message, ruleId);
        case "jest": return classifyJest(message);
        case "go": return classifyGo(message);
        case "shellcheck": return classifyShellcheck(message, ruleId);
        case "rubocop": return classifyRubocop(message, ruleId);
        case "cppcheck": return classifyCppcheck(message, ruleId);
        case "java": return classifyJava(message, ruleId);
        case "dotnet": return classifyDotnet(message, ruleId);
        case "sqlfluff": return classifySqlfluff(message, ruleId);
        case "yamllint": return classifyYamllint(message, ruleId);
        default: {
            const registry = getLanguagePackRegistry();
            const pack = registry.size > 0 ? registry.getByFamily(family) : undefined;
            const classifier = pack?.classifiers[family];
            return classifier ? classifier(message, ruleId) : undefined;
        }
    }
}
export function getRootCause(family, errorFamily) {
    const table = ROOT_CAUSE_TABLES[family];
    return table?.[errorFamily];
}
export function getNextAction(family, errorFamily, file) {
    const table = ACTION_TABLES[family];
    const template = table?.[errorFamily];
    if (!template)
        return undefined;
    return template.replace(/\{file\}/g, file ?? "the affected file");
}
/* ── TypeScript classifier ─────────────────────────────────────── */
function classifyTypescript(msg) {
    const m = msg.toLowerCase();
    if (m.includes("not assignable to type") || m.includes("type '") && m.includes("' is not"))
        return "type_mismatch";
    if (m.includes("cannot find name"))
        return "undeclared_name";
    if (m.includes("does not exist on type"))
        return "missing_property";
    if (m.includes("expected") && m.includes("argument"))
        return "argument_error";
    if (m.includes("not all code paths return"))
        return "missing_return";
    if (m.includes("cannot find module"))
        return "import_error";
    if (m.includes("cannot assign to") && m.includes("read"))
        return "readonly_violation";
    if (m.includes("possibly") && (m.includes("null") || m.includes("undefined")))
        return "null_check";
    if (m.includes("property") && m.includes("missing"))
        return "missing_property";
    if (m.includes("duplicate identifier"))
        return "duplicate_identifier";
    return undefined;
}
/* ── ESLint classifier ─────────────────────────────────────────── */
function classifyEslint(msg, ruleId) {
    const r = (ruleId ?? "").toLowerCase();
    if (r.includes("no-unused"))
        return "unused_symbol";
    if (r.includes("no-undef"))
        return "undeclared_name";
    if (r.includes("no-unreachable"))
        return "unreachable_code";
    if (r.includes("import"))
        return "import_issue";
    if (r.includes("semi") || r.includes("indent") || r.includes("quotes") || r.includes("comma"))
        return "style";
    if (r.includes("no-explicit-any") || r.includes("no-unsafe"))
        return "type_safety";
    if (r.includes("prefer-const") || r.includes("no-var") || r.includes("no-let"))
        return "best_practice";
    if (r.includes("eqeqeq") || r.includes("no-eval") || r.includes("no-implied-eval"))
        return "best_practice";
    if (msg.toLowerCase().includes("unused") || msg.toLowerCase().includes("defined but never used"))
        return "unused_symbol";
    if (msg.toLowerCase().includes("is not defined"))
        return "undeclared_name";
    return undefined;
}
/* ── Ruff classifier ───────────────────────────────────────────── */
function classifyRuff(msg, ruleId) {
    const code = (ruleId ?? "").toUpperCase();
    if (code.startsWith("F4"))
        return "unused_import";
    if (code.startsWith("F8"))
        return "unused_variable";
    if (code === "E501")
        return "line_length";
    if (code.startsWith("E") || code.startsWith("W"))
        return "style";
    if (code.startsWith("ANN"))
        return "type_annotation";
    if (code.startsWith("C9"))
        return "complexity";
    if (code.startsWith("S"))
        return "security";
    if (code.startsWith("B"))
        return "bugbear";
    if (code.startsWith("I"))
        return "import_order";
    if (msg.toLowerCase().includes("unused") && msg.toLowerCase().includes("import"))
        return "unused_import";
    if (msg.toLowerCase().includes("unused"))
        return "unused_variable";
    return undefined;
}
/* ── pytest classifier ─────────────────────────────────────────── */
function classifyPytest(msg) {
    const m = msg.toLowerCase();
    if (m.includes("assert") && (m.includes("==") || m.includes("!=") || m.includes("is not") || m.includes("true") || m.includes("false")))
        return "assertion_failure";
    if (m.includes("fixture") && (m.includes("not found") || m.includes("scope")))
        return "fixture_error";
    if (m.includes("typeerror") || m.includes("type error"))
        return "type_error";
    if (m.includes("importerror") || m.includes("modulenotfounderror") || m.includes("no module named"))
        return "import_error";
    if (m.includes("timeout") || m.includes("timed out"))
        return "timeout";
    if (m.includes("attributeerror"))
        return "attribute_error";
    if (m.includes("keyerror"))
        return "key_error";
    if (m.includes("valueerror"))
        return "value_error";
    if (m.includes("assert"))
        return "assertion_failure";
    return undefined;
}
/* ── mypy classifier ───────────────────────────────────────────── */
function classifyMypy(msg, ruleId) {
    const code = (ruleId ?? "").toLowerCase();
    if (code === "assignment" || msg.toLowerCase().includes("incompatible types in assignment"))
        return "type_mismatch";
    if (code === "arg-type" || msg.toLowerCase().includes("incompatible type") && msg.toLowerCase().includes("argument"))
        return "argument_type";
    if (code === "return-value" || msg.toLowerCase().includes("incompatible return value"))
        return "return_type";
    if (code === "attr-defined" || msg.toLowerCase().includes("has no attribute"))
        return "attribute_access";
    if (code === "name-defined" || msg.toLowerCase().includes("name") && msg.toLowerCase().includes("is not defined"))
        return "undeclared_name";
    if (code === "import" || msg.toLowerCase().includes("cannot find implementation"))
        return "import_error";
    if (code === "override" || msg.toLowerCase().includes("incompatible with supertype"))
        return "override_mismatch";
    if (code === "unused-ignore")
        return "unused_ignore";
    if (code === "no-untyped-def")
        return "missing_annotation";
    if (msg.toLowerCase().includes("incompatible"))
        return "type_mismatch";
    return undefined;
}
/* ── pylint classifier ─────────────────────────────────────────── */
function classifyPylint(msg, ruleId) {
    const code = (ruleId ?? "").toUpperCase();
    if (code.startsWith("E06"))
        return "undeclared_name";
    if (code.startsWith("E11"))
        return "syntax_error";
    if (code.startsWith("C01"))
        return "convention";
    if (code.startsWith("C04"))
        return "naming_convention";
    if (code.startsWith("R09"))
        return "complexity";
    if (code.startsWith("W06"))
        return "unused_symbol";
    if (code.startsWith("W01"))
        return "deprecated";
    if (msg.toLowerCase().includes("undefined variable") || msg.toLowerCase().includes("undefined name"))
        return "undeclared_name";
    if (msg.toLowerCase().includes("unused"))
        return "unused_symbol";
    return undefined;
}
/* ── Terraform classifier ──────────────────────────────────────── */
function classifyTerraform(msg) {
    const m = msg.toLowerCase();
    if (m.includes("reference to undeclared input variable") || m.includes("undeclared variable"))
        return "undeclared_variable";
    if (m.includes("reference to undeclared resource") || m.includes("undeclared resource"))
        return "undeclared_resource";
    if (m.includes("unsupported argument"))
        return "unsupported_argument";
    if (m.includes("missing required argument"))
        return "missing_required_argument";
    if (m.includes("invalid reference"))
        return "invalid_reference";
    if (m.includes("invalid provider configuration") || m.includes("required provider"))
        return "provider_configuration";
    if (m.includes("incorrect attribute value type") || m.includes("invalid value for"))
        return "type_mismatch";
    if (m.includes("unsupported block type"))
        return "unsupported_block";
    if (m.includes("duplicate resource"))
        return "duplicate_resource";
    if (m.includes("cycle"))
        return "dependency_cycle";
    if (m.includes("error:") || m.includes("syntax error"))
        return "syntax_error";
    return undefined;
}
/* ── Cargo / rustc classifier ──────────────────────────────────── */
function classifyCargo(msg, ruleId) {
    const code = (ruleId ?? "").toUpperCase();
    if (code === "E0308" || msg.toLowerCase().includes("mismatched types"))
        return "type_mismatch";
    if (code === "E0425" || msg.toLowerCase().includes("cannot find value"))
        return "undeclared_name";
    if (code === "E0433" || msg.toLowerCase().includes("unresolved import"))
        return "import_error";
    if (code === "E0277" || msg.toLowerCase().includes("trait bound"))
        return "trait_bound";
    if (code === "E0382" || msg.toLowerCase().includes("moved value"))
        return "ownership";
    if (code === "E0502" || code === "E0505" || msg.toLowerCase().includes("borrow"))
        return "borrow_error";
    if (code === "E0599" || msg.toLowerCase().includes("no method named"))
        return "missing_method";
    if (msg.toLowerCase().includes("unused"))
        return "unused_symbol";
    if (msg.toLowerCase().includes("lifetime"))
        return "lifetime";
    return undefined;
}
/* ── golangci-lint classifier ──────────────────────────────────── */
function classifyGolangci(msg, ruleId) {
    const linter = (ruleId ?? "").toLowerCase();
    if (linter === "ineffassign" || msg.toLowerCase().includes("ineffectual assignment"))
        return "unused_assignment";
    if (linter === "govet" || linter === "vet")
        return "vet_error";
    if (linter === "staticcheck" || linter.startsWith("sa"))
        return "static_analysis";
    if (linter === "errcheck" || msg.toLowerCase().includes("error return value"))
        return "unchecked_error";
    if (linter === "gosimple" || linter.startsWith("s1"))
        return "simplification";
    if (linter === "unused" || msg.toLowerCase().includes("unused"))
        return "unused_symbol";
    if (linter === "typecheck")
        return "type_error";
    if (linter === "gocritic")
        return "code_quality";
    return undefined;
}
/* ── Security tools (tfsec, trivy, semgrep) ────────────────────── */
function classifySecurity(msg, ruleId) {
    const m = msg.toLowerCase();
    if (m.includes("critical") || m.includes("remote code execution") || /\brce\b/.test(m))
        return "critical_vulnerability";
    if (m.includes("sql injection") || m.includes("sqli"))
        return "injection";
    if (m.includes("xss") || m.includes("cross-site scripting"))
        return "xss";
    if (m.includes("secret") || m.includes("credential") || m.includes("password") || m.includes("api key"))
        return "secret_exposure";
    if (m.includes("encryption") || m.includes("unencrypted") || m.includes("plaintext"))
        return "weak_encryption";
    if (m.includes("permission") || m.includes("privilege") || m.includes("wildcard"))
        return "excessive_permissions";
    if (m.includes("versioning") || m.includes("logging") || m.includes("audit"))
        return "missing_hardening";
    if (ruleId?.toUpperCase().startsWith("CVE"))
        return "known_cve";
    return undefined;
}
/* ── Jest classifier ──────────────────────────────────────────── */
function classifyJest(msg) {
    const m = msg.toLowerCase();
    if (m.includes("expect(") || m.includes("tobe") || m.includes("toequal") || (m.includes("expected") && m.includes("received")))
        return "assertion_failure";
    if (m.includes("cannot find module") || m.includes("module not found"))
        return "import_error";
    if (m.includes("timeout"))
        return "timeout";
    if (m.includes("typeerror"))
        return "type_error";
    if (m.includes("referenceerror"))
        return "reference_error";
    if (m.includes("snapshot") && (m.includes("obsolete") || m.includes("does not match")))
        return "snapshot_mismatch";
    if (m.includes("mock") && (m.includes("not called") || m.includes("called with")))
        return "mock_assertion";
    if (m.includes("syntaxerror"))
        return "syntax_error";
    return undefined;
}
/* ── Go build classifier ─────────────────────────────────────── */
function classifyGo(msg) {
    const m = msg.toLowerCase();
    if (m.includes("undefined:") || m.includes("undeclared name"))
        return "undeclared_name";
    if (m.includes("cannot use") && m.includes("as type"))
        return "type_mismatch";
    if (m.includes("imported and not used"))
        return "unused_import";
    if (m.includes("declared and not used") || m.includes("declared but not used"))
        return "unused_variable";
    if (m.includes("cannot convert") || m.includes("cannot assign"))
        return "type_conversion";
    if (m.includes("too many arguments") || m.includes("not enough arguments"))
        return "argument_error";
    if (m.includes("multiple-value") && m.includes("single-value"))
        return "multi_value";
    if (m.includes("syntax error"))
        return "syntax_error";
    if (m.includes("cycl") && m.includes("import"))
        return "import_cycle";
    return undefined;
}
/* ── ShellCheck classifier ───────────────────────────────────── */
function classifyShellcheck(msg, ruleId) {
    const code = (ruleId ?? "").toUpperCase();
    if (code === "SC2086" || msg.includes("Double quote"))
        return "unquoted_variable";
    if (code === "SC2046")
        return "unquoted_expansion";
    if (code === "SC2004" || code === "SC2006")
        return "deprecated_syntax";
    if (code === "SC2034" || msg.toLowerCase().includes("unused"))
        return "unused_variable";
    if (code === "SC2155")
        return "declare_assign";
    if (code === "SC2164")
        return "missing_cd_check";
    if (code === "SC2181")
        return "indirect_exit_code";
    if (code === "SC1091" || code === "SC1090")
        return "unresolvable_source";
    if (code === "SC2162")
        return "missing_read_r";
    if (/^SC2/.test(code))
        return "warning";
    if (/^SC1/.test(code))
        return "syntax_issue";
    return undefined;
}
/* ── RuboCop classifier ──────────────────────────────────────── */
function classifyRubocop(msg, ruleId) {
    const r = (ruleId ?? "").toLowerCase();
    if (r.startsWith("style/") || r.startsWith("layout/"))
        return "style";
    if (r.startsWith("lint/"))
        return "lint_warning";
    if (r.startsWith("metrics/"))
        return "complexity";
    if (r.startsWith("naming/"))
        return "naming_convention";
    if (r.startsWith("security/"))
        return "security";
    if (r.includes("uselessassignment") || msg.toLowerCase().includes("unused"))
        return "unused_symbol";
    if (r.includes("methodlength") || r.includes("abcsize") || r.includes("cyclomaticcomplexity"))
        return "complexity";
    if (msg.toLowerCase().includes("too long"))
        return "line_length";
    return undefined;
}
/* ── cppcheck classifier ─────────────────────────────────────── */
function classifyCppcheck(msg, ruleId) {
    const id = (ruleId ?? "").toLowerCase();
    if (id === "nullpointer" || id === "nullpointerdereference" || msg.toLowerCase().includes("null pointer"))
        return "null_dereference";
    if (id === "memleak" || id === "resourceleak" || msg.toLowerCase().includes("memory leak"))
        return "memory_leak";
    if (id === "uninitvar" || msg.toLowerCase().includes("uninitialized"))
        return "uninitialized_variable";
    if (id === "bufferoverrun" || id === "arrayindexoutofbounds" || msg.toLowerCase().includes("buffer"))
        return "buffer_overflow";
    if (id === "unusedfunction" || id === "unusedvariable" || msg.toLowerCase().includes("unused"))
        return "unused_symbol";
    if (id === "syntaxerror" || msg.toLowerCase().includes("syntax error"))
        return "syntax_error";
    if (id === "danglinglifetime" || id === "returnreference")
        return "dangling_reference";
    if (msg.toLowerCase().includes("division by zero"))
        return "division_by_zero";
    return undefined;
}
/* ── Java (javac / Maven / Gradle) classifier ─────────────────── */
function classifyJava(msg, ruleId) {
    const m = msg.toLowerCase();
    if (m.includes("cannot find symbol") || m.includes("cannot resolve symbol"))
        return "undeclared_name";
    if (m.includes("incompatible types") || m.includes("inconvertible types"))
        return "type_mismatch";
    if (m.includes("package") && m.includes("does not exist"))
        return "import_error";
    if (m.includes("unreported exception") || m.includes("must be caught or declared"))
        return "unchecked_exception";
    if (m.includes("method does not override") || m.includes("is not abstract"))
        return "override_error";
    if (m.includes("variable") && m.includes("might not have been initialized"))
        return "uninitialized_variable";
    if (m.includes("unreachable statement"))
        return "unreachable_code";
    if (m.includes("duplicate class") || m.includes("already defined"))
        return "duplicate_definition";
    if (m.includes("cannot access") || m.includes("has private access"))
        return "access_error";
    if (m.includes("deprecated"))
        return "deprecated";
    if (m.includes("non-static") && m.includes("static context"))
        return "static_context";
    if (m.includes("nullpointerexception") || m.includes("null pointer"))
        return "null_dereference";
    if (ruleId?.toLowerCase().includes("checkstyle"))
        return "style";
    return undefined;
}
/* ── C# / .NET (dotnet build / Roslyn) classifier ─────────────── */
function classifyDotnet(msg, ruleId) {
    const code = (ruleId ?? "").toUpperCase();
    const m = msg.toLowerCase();
    if (code.startsWith("CS0103") || m.includes("does not exist in the current context"))
        return "undeclared_name";
    if (code.startsWith("CS0029") || m.includes("cannot implicitly convert"))
        return "type_mismatch";
    if (code.startsWith("CS0246") || m.includes("type or namespace") && m.includes("could not be found"))
        return "import_error";
    if (code.startsWith("CS0234") || m.includes("does not exist in the namespace"))
        return "namespace_error";
    if (code.startsWith("CS1061") || m.includes("does not contain a definition"))
        return "missing_member";
    if (code.startsWith("CS0168") || m.includes("declared but never used"))
        return "unused_variable";
    if (code.startsWith("CS8600") || m.includes("converting null literal"))
        return "null_check";
    if (code.startsWith("CS0162") || m.includes("unreachable code"))
        return "unreachable_code";
    if (code.startsWith("CS0019") || m.includes("cannot be applied to operands"))
        return "operator_error";
    if (m.includes("ambiguous") && m.includes("reference"))
        return "ambiguous_reference";
    if (m.includes("obsolete") || m.includes("deprecated"))
        return "deprecated";
    return undefined;
}
/* ── SQL (sqlfluff / query errors) classifier ──────────────────── */
function classifySqlfluff(msg, ruleId) {
    const code = (ruleId ?? "").toUpperCase();
    const m = msg.toLowerCase();
    if (code.startsWith("L0") || m.includes("indentation"))
        return "style";
    if (code === "L014" || m.includes("inconsistent capitalisation"))
        return "naming_convention";
    if (code === "L036" || m.includes("select targets"))
        return "select_style";
    if (code === "L044" || m.includes("query produces"))
        return "query_structure";
    if (m.includes("syntax error") || m.includes("unexpected token"))
        return "syntax_error";
    if (m.includes("unknown column") || m.includes("column") && m.includes("not found"))
        return "undeclared_column";
    if (m.includes("table") && (m.includes("not found") || m.includes("doesn't exist")))
        return "undeclared_table";
    if (m.includes("ambiguous column"))
        return "ambiguous_reference";
    if (m.includes("division by zero"))
        return "division_by_zero";
    if (m.includes("deadlock"))
        return "deadlock";
    if (m.includes("permission denied") || m.includes("access denied"))
        return "permission_error";
    return undefined;
}
/* ── YAML lint classifier ──────────────────────────────────────── */
function classifyYamllint(msg, ruleId) {
    const r = (ruleId ?? "").toLowerCase();
    const m = msg.toLowerCase();
    if (r === "indentation" || m.includes("wrong indentation"))
        return "indentation";
    if (r === "line-length" || m.includes("line too long"))
        return "line_length";
    if (r === "trailing-spaces" || m.includes("trailing spaces"))
        return "trailing_spaces";
    if (r === "truthy" || m.includes("truthy value"))
        return "truthy_value";
    if (r === "document-start" || m.includes("missing document start"))
        return "document_start";
    if (m.includes("syntax error") || m.includes("mapping values"))
        return "syntax_error";
    if (m.includes("duplicate key") || m.includes("duplication of key"))
        return "duplicate_key";
    if (m.includes("could not find expected"))
        return "syntax_error";
    return undefined;
}
/* ── Root cause tables ─────────────────────────────────────────── */
const ROOT_CAUSE_TABLES = {
    typescript: {
        type_mismatch: "Value type does not match the declared or inferred type at this position.",
        undeclared_name: "An identifier is referenced but not declared in the current scope or imports.",
        missing_property: "The accessed property does not exist on the target type.",
        argument_error: "Function call has the wrong number or types of arguments.",
        missing_return: "Not all code paths in this function return a value.",
        import_error: "The referenced module or package cannot be resolved.",
        readonly_violation: "Attempted assignment to a property marked as readonly.",
        null_check: "A value may be null or undefined at this point and strict checks require handling it.",
        duplicate_identifier: "The same identifier is declared more than once in the same scope."
    },
    eslint: {
        unused_symbol: "A variable, import, or parameter is declared but never referenced.",
        undeclared_name: "An identifier is used without being declared or imported.",
        unreachable_code: "Code appears after a return, throw, or break and can never execute.",
        import_issue: "An import path is unresolved, misordered, or duplicated.",
        style: "Code formatting does not match the configured style rules.",
        type_safety: "Usage of `any` or unsafe type operations weakens type guarantees.",
        best_practice: "Code uses a pattern that is error-prone or has a safer alternative."
    },
    ruff: {
        unused_import: "An import statement brings in a name that is never used in this file.",
        unused_variable: "A variable is assigned a value that is never read.",
        line_length: "A line exceeds the configured maximum character width.",
        style: "Code formatting does not match the configured style rules.",
        type_annotation: "A function or parameter is missing a type annotation.",
        complexity: "A function or expression has too many branches or is too deeply nested.",
        security: "A potentially unsafe pattern was detected (e.g. exec, eval, hardcoded password).",
        bugbear: "A likely bug or footgun pattern was detected.",
        import_order: "Import statements are not in the expected order."
    },
    pytest: {
        assertion_failure: "A test assertion evaluated to False — the actual value differs from expected.",
        fixture_error: "A test fixture could not be found, has a scope conflict, or failed during setup.",
        type_error: "A function received an argument of the wrong type during test execution.",
        import_error: "A module required by the test could not be imported.",
        timeout: "The test exceeded the configured time limit.",
        attribute_error: "An object does not have the expected attribute or method.",
        key_error: "A dictionary or mapping was accessed with a key that does not exist.",
        value_error: "A function received a value with the right type but an invalid value."
    },
    mypy: {
        type_mismatch: "The assigned value's type is incompatible with the declared variable type.",
        argument_type: "A function argument's type does not match the parameter's annotation.",
        return_type: "The returned value's type is incompatible with the function's return annotation.",
        attribute_access: "An attribute or method does not exist on the inferred type.",
        undeclared_name: "A name is used that mypy cannot find in scope.",
        import_error: "A module import cannot be resolved or has no type stubs.",
        override_mismatch: "A method override signature is incompatible with the base class.",
        unused_ignore: "A `# type: ignore` comment suppresses no actual error.",
        missing_annotation: "A function definition is missing type annotations."
    },
    pylint: {
        undeclared_name: "A variable or name is referenced but not defined in the current scope.",
        syntax_error: "The file contains a Python syntax error that prevents parsing.",
        convention: "Code does not follow PEP 8 or project-configured conventions.",
        naming_convention: "A name does not match the expected naming pattern (snake_case, UPPER_CASE, etc.).",
        complexity: "A function or class has too many branches, arguments, or local variables.",
        unused_symbol: "A variable, import, or argument is defined but never used.",
        deprecated: "A deprecated function, method, or module is being used."
    },
    terraform: {
        undeclared_variable: "An input variable is referenced but not declared in any variables file.",
        undeclared_resource: "A resource is referenced but not defined in the current configuration.",
        unsupported_argument: "A block contains an argument that the resource, module, or provider does not accept.",
        missing_required_argument: "A required attribute or module input is missing from the block.",
        invalid_reference: "An expression references something that cannot be resolved.",
        provider_configuration: "Provider settings or required provider inputs are incomplete or invalid.",
        type_mismatch: "A value type does not match what the resource or variable expects.",
        unsupported_block: "A nested block type is not supported by the enclosing resource or module.",
        duplicate_resource: "Two resources share the same type and name, creating an ambiguity.",
        dependency_cycle: "Resources or modules form a circular dependency that Terraform cannot resolve.",
        syntax_error: "The configuration file contains an HCL syntax error."
    },
    cargo: {
        type_mismatch: "The value's type does not match what the context expects.",
        undeclared_name: "A name is used that is not in scope — missing import or declaration.",
        import_error: "A crate or module path cannot be resolved.",
        trait_bound: "A type does not implement a required trait.",
        ownership: "A value was used after being moved — Rust's ownership rules prevent this.",
        borrow_error: "A borrow conflict: the value is already borrowed mutably or immutably.",
        missing_method: "The method does not exist on the type, or a trait needs to be imported.",
        unused_symbol: "A variable, import, or function is declared but never used.",
        lifetime: "Lifetime annotations are missing or conflicting."
    },
    "golangci-lint": {
        unused_assignment: "A variable is assigned a value that is immediately overwritten or never read.",
        vet_error: "Go vet found a likely mistake (e.g. wrong printf format, unreachable code).",
        static_analysis: "Staticcheck found a code pattern that is almost certainly a bug or anti-pattern.",
        unchecked_error: "A function returns an error that is not checked.",
        simplification: "Code can be written in a simpler, more idiomatic way.",
        unused_symbol: "A variable, function, or type is declared but not used.",
        type_error: "A type error was detected during compilation.",
        code_quality: "A code quality issue was detected (naming, complexity, or style)."
    },
    tfsec: {
        critical_vulnerability: "A security misconfiguration could allow remote exploitation.",
        injection: "Input is used in a query or command without sanitization.",
        secret_exposure: "Sensitive credentials or secrets appear in source or configuration.",
        weak_encryption: "Data is transmitted or stored without adequate encryption.",
        excessive_permissions: "Permissions are broader than necessary (e.g. IAM wildcards).",
        missing_hardening: "A recommended security control (logging, versioning, etc.) is not enabled.",
        known_cve: "A dependency has a known CVE with published exploits or patches."
    },
    trivy: {
        critical_vulnerability: "A dependency has a critical severity vulnerability with known exploits.",
        injection: "A code pattern allows injection attacks.",
        secret_exposure: "Credentials or API keys are embedded in code or configuration.",
        weak_encryption: "Weak or deprecated cryptographic algorithms are in use.",
        excessive_permissions: "Container or cloud permissions are broader than necessary.",
        missing_hardening: "A recommended security baseline control is not configured.",
        known_cve: "A dependency has a known CVE — check if a patched version is available."
    },
    semgrep: {
        critical_vulnerability: "A code pattern matches a known vulnerability signature.",
        injection: "User input flows into a dangerous sink without sanitization.",
        xss: "User-controlled data is rendered in HTML without escaping.",
        secret_exposure: "Hardcoded secrets or credentials detected in source code.",
        weak_encryption: "Deprecated or weak cryptographic usage detected.",
        excessive_permissions: "Overly broad access controls or permission grants.",
        missing_hardening: "A security best practice is not followed."
    },
    jest: {
        assertion_failure: "A test assertion failed — the actual value differs from expected.",
        import_error: "A module required by the test could not be found or resolved.",
        timeout: "The test exceeded the configured time limit.",
        type_error: "A function was called with the wrong type during test execution.",
        reference_error: "An undeclared variable or function was referenced at runtime.",
        snapshot_mismatch: "The rendered output no longer matches the stored snapshot.",
        mock_assertion: "A mock function was not called as expected.",
        syntax_error: "The test file contains a syntax error that prevents parsing."
    },
    go: {
        undeclared_name: "An identifier is used but not declared or imported.",
        type_mismatch: "The value type does not match the expected type in this context.",
        unused_import: "A package is imported but not used.",
        unused_variable: "A variable is declared but never read.",
        type_conversion: "A value cannot be converted or assigned to the target type.",
        argument_error: "A function was called with the wrong number of arguments.",
        multi_value: "A multi-value expression was used in a single-value context.",
        syntax_error: "The source file contains a Go syntax error.",
        import_cycle: "Packages form a circular import dependency."
    },
    shellcheck: {
        unquoted_variable: "A variable expansion is not quoted, risking word splitting and globbing.",
        unquoted_expansion: "A command substitution or expansion is not quoted.",
        deprecated_syntax: "A deprecated Bash/POSIX syntax is used — a modern alternative exists.",
        unused_variable: "A variable is assigned but never referenced.",
        declare_assign: "Combining declaration and assignment masks the exit code of the subshell.",
        missing_cd_check: "A `cd` command is used without checking its exit status.",
        indirect_exit_code: "Checking $? instead of using the command directly in `if`.",
        unresolvable_source: "A sourced file cannot be resolved for static analysis.",
        missing_read_r: "`read` without `-r` will mangle backslashes.",
        warning: "A general ShellCheck warning was raised.",
        syntax_issue: "A shell syntax issue was detected."
    },
    rubocop: {
        style: "Code formatting does not match the configured Ruby style rules.",
        lint_warning: "A likely bug or questionable pattern was detected.",
        complexity: "A method or class is too complex (too many branches or lines).",
        naming_convention: "A name does not follow the expected Ruby naming convention.",
        security: "A potential security issue was detected in Ruby code.",
        unused_symbol: "A variable, method, or assignment is never used.",
        line_length: "A line exceeds the configured maximum character width."
    },
    cppcheck: {
        null_dereference: "A pointer is dereferenced that may be null at this point.",
        memory_leak: "Allocated memory is not freed on all code paths.",
        uninitialized_variable: "A variable is used before being assigned a value.",
        buffer_overflow: "An array or buffer is accessed beyond its allocated size.",
        unused_symbol: "A variable or function is declared but never used.",
        syntax_error: "The source file contains a C/C++ syntax error.",
        dangling_reference: "A reference or pointer outlives the object it refers to.",
        division_by_zero: "A division by zero can occur at runtime."
    },
    java: {
        undeclared_name: "A symbol (variable, method, class) is referenced but not declared or imported.",
        type_mismatch: "The value type is incompatible with the expected type in this context.",
        import_error: "A package or class cannot be resolved — missing dependency or wrong import.",
        unchecked_exception: "A checked exception is thrown but not caught or declared in the method signature.",
        override_error: "A method does not correctly override a superclass method.",
        uninitialized_variable: "A local variable may not have been assigned before use.",
        unreachable_code: "Code appears after a return or throw and can never execute.",
        duplicate_definition: "A class, method, or variable is defined more than once in the same scope.",
        access_error: "Attempting to access a member with insufficient visibility (private/protected).",
        deprecated: "A deprecated API is being used — a newer alternative exists.",
        static_context: "A non-static member is referenced from a static context.",
        null_dereference: "A NullPointerException can occur because a reference may be null.",
        style: "Code does not follow the configured style rules (Checkstyle)."
    },
    dotnet: {
        undeclared_name: "A name is used that does not exist in the current context.",
        type_mismatch: "An implicit type conversion is not possible between the given types.",
        import_error: "A type or namespace could not be found — missing using directive or assembly reference.",
        namespace_error: "A type does not exist in the specified namespace.",
        missing_member: "The type does not contain a definition for the accessed member.",
        unused_variable: "A variable is declared but its value is never used.",
        null_check: "A null literal or possible null value is assigned to a non-nullable type.",
        unreachable_code: "Code is unreachable and will never execute.",
        operator_error: "An operator cannot be applied to the given operand types.",
        ambiguous_reference: "An ambiguous reference exists between two or more types.",
        deprecated: "An obsolete API is being used."
    },
    sqlfluff: {
        style: "SQL formatting does not match configured style rules.",
        naming_convention: "Inconsistent capitalization of keywords or identifiers.",
        select_style: "SELECT targets should be on separate lines or follow style rules.",
        query_structure: "Query structure does not follow best practices.",
        syntax_error: "The SQL statement contains a syntax error.",
        undeclared_column: "A column is referenced that does not exist in the table.",
        undeclared_table: "A table is referenced that does not exist in the schema.",
        ambiguous_reference: "An ambiguous column reference exists in a multi-table query.",
        division_by_zero: "A division by zero can occur at runtime.",
        deadlock: "A potential deadlock condition was detected.",
        permission_error: "Insufficient permissions to access the resource."
    },
    yamllint: {
        indentation: "YAML indentation does not match the expected level.",
        line_length: "A line exceeds the configured maximum width.",
        trailing_spaces: "Trailing whitespace found at end of line.",
        truthy_value: "A truthy value should be explicitly true/false, not yes/no/on/off.",
        document_start: "Missing document start marker (---) at beginning of file.",
        syntax_error: "The YAML file contains a syntax error.",
        duplicate_key: "A mapping key is duplicated — only the last value will be used."
    }
};
/* ── Suggested next action tables ──────────────────────────────── */
const ACTION_TABLES = {
    typescript: {
        type_mismatch: "Check the assignment or argument in {file} and align the types, or add an explicit cast.",
        undeclared_name: "Declare the identifier or add the correct import in {file}.",
        missing_property: "Check the type definition — the property may be misspelled or the type may need extending.",
        argument_error: "Check the function signature and adjust the call site in {file}.",
        missing_return: "Add a return statement to all code paths in the function in {file}.",
        import_error: "Verify the module path and ensure the package is installed.",
        readonly_violation: "Use a mutable copy or remove the readonly modifier if mutation is intentional.",
        null_check: "Add a null/undefined check or use optional chaining (?.) / nullish coalescing (??) in {file}.",
        duplicate_identifier: "Rename one of the duplicate declarations in {file}."
    },
    eslint: {
        unused_symbol: "Remove the unused declaration or prefix with underscore to indicate intentional disuse.",
        undeclared_name: "Declare the variable or add the missing import.",
        unreachable_code: "Remove the unreachable code or fix the control flow above it.",
        import_issue: "Check the import path, install missing packages, or reorder imports.",
        style: "Run the project formatter (prettier/eslint --fix) to auto-correct.",
        type_safety: "Replace `any` with a specific type or add proper type narrowing.",
        best_practice: "Refactor to the safer alternative suggested by the rule."
    },
    ruff: {
        unused_import: "Remove the unused import from {file} or add it to __all__ if re-exported.",
        unused_variable: "Remove the variable or prefix with _ if intentionally unused.",
        line_length: "Break the line or extract a local variable to reduce width.",
        style: "Run `ruff format` or `ruff check --fix` to auto-correct.",
        type_annotation: "Add type annotations to the function signature.",
        complexity: "Extract helper functions to reduce branch depth or argument count.",
        security: "Review the flagged pattern in {file} — avoid eval/exec and hardcoded credentials.",
        bugbear: "Review the flagged pattern — it is likely a bug or surprising behavior.",
        import_order: "Run `ruff check --fix` to reorder imports automatically."
    },
    pytest: {
        assertion_failure: "Check the expected value in the assertion — update the test or fix the implementation.",
        fixture_error: "Verify the fixture name, scope, and conftest.py placement.",
        type_error: "Check the argument types passed in the test setup or function call.",
        import_error: "Verify the module path and ensure the package is installed in the test environment.",
        timeout: "Investigate why the test is slow — mock external calls or increase the timeout.",
        attribute_error: "Check that the object has the expected attribute — it may have changed type.",
        key_error: "Verify the dictionary key exists — add a default or check before access.",
        value_error: "Check the value passed to the function — it may be out of range or malformed."
    },
    mypy: {
        type_mismatch: "Fix the assignment in {file} to match the declared type, or add an explicit cast.",
        argument_type: "Adjust the argument type at the call site or widen the parameter annotation.",
        return_type: "Fix the return expression or update the return type annotation in {file}.",
        attribute_access: "Check the type — the attribute may not exist or a different type is needed.",
        undeclared_name: "Add the missing import or declare the name in {file}.",
        import_error: "Install type stubs (e.g. types-requests) or add a py.typed marker.",
        override_mismatch: "Align the method signature with the base class definition.",
        unused_ignore: "Remove the unnecessary `# type: ignore` comment.",
        missing_annotation: "Add type annotations to the function definition."
    },
    pylint: {
        undeclared_name: "Declare or import the missing name in {file}.",
        syntax_error: "Fix the syntax error — check for unmatched brackets, missing colons, or indentation.",
        convention: "Follow PEP 8 or project style guide — run `pylint --fix` if available.",
        naming_convention: "Rename to match the expected pattern (snake_case for functions, UPPER_CASE for constants).",
        complexity: "Extract helper functions or reduce the number of branches and arguments.",
        unused_symbol: "Remove the unused declaration or prefix with _ if intentionally unused.",
        deprecated: "Replace with the recommended modern alternative."
    },
    terraform: {
        undeclared_variable: "Inspect {file} and the corresponding variables.tf for a missing variable declaration.",
        undeclared_resource: "Add the missing resource block or fix the reference in {file}.",
        unsupported_argument: "Remove or rename the unsupported argument in the block in {file}.",
        missing_required_argument: "Add the missing required argument to the block in {file}.",
        invalid_reference: "Fix the expression — check resource names, data sources, and module outputs.",
        provider_configuration: "Check the provider block and required_providers — ensure credentials and region are set.",
        type_mismatch: "Check the attribute value type against the provider schema and fix the expression in {file}.",
        unsupported_block: "Remove the unsupported nested block or check the resource/module documentation.",
        duplicate_resource: "Rename one of the duplicate resources to make names unique.",
        dependency_cycle: "Break the circular dependency — use depends_on explicitly or restructure modules.",
        syntax_error: "Fix the HCL syntax — check for unmatched braces, missing equals signs, or invalid tokens."
    },
    cargo: {
        type_mismatch: "Fix the type in {file} — check assignments, function returns, and generic parameters.",
        undeclared_name: "Add the missing `use` import or declare the item in {file}.",
        import_error: "Check the crate name in Cargo.toml and the `use` path in {file}.",
        trait_bound: "Implement the required trait or add a trait bound to the generic parameter.",
        ownership: "Clone the value, restructure to avoid the move, or use references instead.",
        borrow_error: "Restructure the code to avoid simultaneous mutable and immutable borrows.",
        missing_method: "Import the trait that provides the method, or check the type.",
        unused_symbol: "Remove the unused item or prefix with _ to suppress the warning.",
        lifetime: "Add explicit lifetime annotations or restructure to use owned types."
    },
    "golangci-lint": {
        unused_assignment: "Remove the assignment or use the variable before it is overwritten.",
        vet_error: "Fix the issue flagged by go vet — check printf formats and unreachable code.",
        static_analysis: "Fix the bug pattern identified by staticcheck.",
        unchecked_error: "Handle the returned error — check and propagate or log it.",
        simplification: "Simplify the code as suggested — Go prefers direct, idiomatic patterns.",
        unused_symbol: "Remove the unused declaration or export it if needed.",
        type_error: "Fix the type error — check assignments and function signatures.",
        code_quality: "Address the code quality issue — improve naming, reduce complexity, or fix style."
    },
    tfsec: {
        critical_vulnerability: "Fix the security misconfiguration immediately — see the rule documentation for remediation steps.",
        injection: "Sanitize all user input before passing it to queries or commands.",
        secret_exposure: "Move secrets to a secrets manager (Vault, AWS Secrets Manager) and reference them indirectly.",
        weak_encryption: "Enable encryption at rest and in transit — use TLS 1.2+ and AES-256.",
        excessive_permissions: "Narrow the IAM policy — replace wildcards with specific resource ARNs and actions.",
        missing_hardening: "Enable the recommended control (versioning, logging, etc.) as per the security baseline.",
        known_cve: "Upgrade the affected dependency to the patched version."
    },
    trivy: {
        critical_vulnerability: "Upgrade the affected package to the fixed version listed in the vulnerability report.",
        injection: "Add input validation and use parameterized queries or prepared statements.",
        secret_exposure: "Remove hardcoded secrets and use environment variables or a secrets manager.",
        weak_encryption: "Replace deprecated algorithms with modern alternatives (e.g. bcrypt, AES-GCM).",
        excessive_permissions: "Follow least-privilege — reduce container capabilities and cloud IAM scope.",
        missing_hardening: "Apply the security baseline — enable health checks, read-only root filesystem, non-root user.",
        known_cve: "Upgrade the vulnerable dependency to the version that includes the CVE fix."
    },
    semgrep: {
        critical_vulnerability: "Fix the vulnerability pattern identified by the Semgrep rule.",
        injection: "Use parameterized queries and validate/sanitize all external input.",
        xss: "Escape user-controlled data before rendering in HTML — use framework auto-escaping.",
        secret_exposure: "Remove hardcoded secrets and load them from environment variables or a vault.",
        weak_encryption: "Replace weak or deprecated crypto with recommended alternatives.",
        excessive_permissions: "Tighten access controls to follow least-privilege.",
        missing_hardening: "Enable the security control recommended by the rule."
    },
    jest: {
        assertion_failure: "Check the expected value — update the test or fix the implementation under test.",
        import_error: "Verify the module path and ensure the package is installed in the test environment.",
        timeout: "Mock long-running calls or increase the test timeout.",
        type_error: "Check the types passed in the test setup or function call.",
        reference_error: "Declare the variable or add the missing import in {file}.",
        snapshot_mismatch: "Run `jest --updateSnapshot` if the change is intentional, or fix the component.",
        mock_assertion: "Verify the mock setup and ensure the function under test calls the mock as expected.",
        syntax_error: "Fix the syntax error in {file} — check for unmatched brackets or template literals."
    },
    go: {
        undeclared_name: "Add the missing import or declare the identifier in {file}.",
        type_mismatch: "Fix the type — check assignments and function signatures in {file}.",
        unused_import: "Remove the unused import or use the package in {file}.",
        unused_variable: "Use or remove the declared variable in {file}.",
        type_conversion: "Add an explicit type conversion or change the target type.",
        argument_error: "Check the function signature and pass the correct number of arguments.",
        multi_value: "Assign the multi-value result to separate variables (e.g. val, err := ...).",
        syntax_error: "Fix the syntax error — check for unmatched braces or missing semicolons.",
        import_cycle: "Break the import cycle by introducing an interface or moving shared types to a separate package."
    },
    shellcheck: {
        unquoted_variable: "Wrap the variable expansion in double quotes: \"$var\".",
        unquoted_expansion: "Quote the command substitution: \"$(cmd)\" to prevent word splitting.",
        deprecated_syntax: "Replace with the modern syntax suggested by ShellCheck.",
        unused_variable: "Remove the unused variable or export it if needed.",
        declare_assign: "Split declaration and assignment onto separate lines to preserve exit codes.",
        missing_cd_check: "Add `|| exit` after `cd` to handle directory change failures.",
        indirect_exit_code: "Use `if command; then ...` directly instead of checking $? after.",
        unresolvable_source: "Add a `# shellcheck source=path` directive or verify the sourced file path.",
        missing_read_r: "Add the `-r` flag to `read` to prevent backslash interpretation.",
        warning: "Review the ShellCheck warning and apply the suggested fix.",
        syntax_issue: "Fix the shell syntax — check for unmatched quotes, brackets, or keywords."
    },
    rubocop: {
        style: "Run `rubocop -A` to auto-correct, or fix the style issue manually.",
        lint_warning: "Review the flagged pattern — it may be a bug or have surprising behavior.",
        complexity: "Extract helper methods to reduce branch depth and line count.",
        naming_convention: "Rename to match the Ruby convention (snake_case for methods, CamelCase for classes).",
        security: "Review the flagged security issue in {file} — see the RuboCop rule docs for remediation.",
        unused_symbol: "Remove the unused variable, method, or assignment.",
        line_length: "Break the line or extract a local variable to reduce width."
    },
    cppcheck: {
        null_dereference: "Add a null check before dereferencing the pointer in {file}.",
        memory_leak: "Free the allocated memory on all code paths, or use RAII / smart pointers.",
        uninitialized_variable: "Initialize the variable at declaration in {file}.",
        buffer_overflow: "Add bounds checking before the array/buffer access in {file}.",
        unused_symbol: "Remove the unused variable or function.",
        syntax_error: "Fix the syntax error — check for unmatched braces or missing semicolons.",
        dangling_reference: "Ensure the referenced object outlives the pointer or reference.",
        division_by_zero: "Add a check for zero before the division in {file}."
    },
    java: {
        undeclared_name: "Add the missing import or declare the symbol in {file}.",
        type_mismatch: "Fix the type — check assignments, casts, and generic parameters in {file}.",
        import_error: "Add the correct import statement or ensure the dependency is in pom.xml / build.gradle.",
        unchecked_exception: "Add a try-catch block or declare the exception in the method signature.",
        override_error: "Ensure the method signature matches the superclass — check return type and parameters.",
        uninitialized_variable: "Initialize the local variable at declaration in {file}.",
        unreachable_code: "Remove the unreachable code or fix the control flow above it.",
        duplicate_definition: "Rename one of the duplicate definitions in {file}.",
        access_error: "Change the access modifier or access through a public method.",
        deprecated: "Replace with the recommended modern alternative — see @Deprecated javadoc.",
        static_context: "Make the member static or create an instance to access it.",
        null_dereference: "Add a null check before dereferencing the reference in {file}.",
        style: "Run Checkstyle to see the style violations and fix them."
    },
    dotnet: {
        undeclared_name: "Add a using directive or declare the name in {file}.",
        type_mismatch: "Add an explicit cast or change the target type in {file}.",
        import_error: "Add the missing using directive or NuGet package reference.",
        namespace_error: "Check the namespace — add a using directive or verify the assembly reference.",
        missing_member: "Check the type definition — the member may not exist or an extension method may be needed.",
        unused_variable: "Remove the unused variable or use discard (_) in {file}.",
        null_check: "Add a null check or use the null-conditional operator (?.) in {file}.",
        unreachable_code: "Remove the unreachable code or fix the control flow above it.",
        operator_error: "Check the operand types — add a cast or use a compatible operator.",
        ambiguous_reference: "Qualify the reference with the full namespace to resolve the ambiguity.",
        deprecated: "Replace with the recommended modern alternative."
    },
    sqlfluff: {
        style: "Run `sqlfluff fix` to auto-correct formatting.",
        naming_convention: "Standardize keyword/identifier capitalization — use UPPER for keywords, lower for identifiers.",
        select_style: "Place each SELECT target on its own line for readability.",
        query_structure: "Restructure the query following SQL best practices.",
        syntax_error: "Fix the SQL syntax — check for unclosed parentheses, missing commas, or invalid keywords.",
        undeclared_column: "Verify the column name exists in the table — check for typos or missing joins in {file}.",
        undeclared_table: "Verify the table exists — check for typos or missing schema qualifier.",
        ambiguous_reference: "Qualify the column with the table alias to resolve the ambiguity.",
        division_by_zero: "Add a NULLIF or CASE guard before the division.",
        deadlock: "Review transaction order and lock granularity to prevent deadlocks.",
        permission_error: "Grant the necessary permissions or use a role with sufficient access."
    },
    yamllint: {
        indentation: "Fix the indentation to match the expected level (usually 2 spaces) in {file}.",
        line_length: "Break the line or use YAML block scalars (| or >) to reduce line width.",
        trailing_spaces: "Remove trailing whitespace from the end of the line.",
        truthy_value: "Replace yes/no/on/off with true/false for boolean values.",
        document_start: "Add '---' at the beginning of the YAML document.",
        syntax_error: "Fix the YAML syntax — check for incorrect indentation, unquoted special characters, or unclosed strings.",
        duplicate_key: "Remove the duplicate key — only the last value is used."
    }
};
