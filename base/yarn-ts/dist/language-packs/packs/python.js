import { classifyErrorFamily } from "../../validation/enrichment.js";
export const pythonPack = {
    id: "lang-python",
    language: "python",
    displayName: "Python",
    version: "1.0.0",
    families: ["ruff", "pytest", "mypy", "pylint"],
    toolSignals: [
        { pattern: /\bruff\b/i, family: "ruff" },
        { pattern: /\bpytest\b|\bpy\.test\b/i, family: "pytest" },
        { pattern: /\bmypy\b/i, family: "mypy" },
        { pattern: /\bpylint\b/i, family: "pylint" },
    ],
    classifiers: {
        ruff: (msg, ruleId) => classifyErrorFamily("ruff", msg, ruleId),
        pytest: (msg, ruleId) => classifyErrorFamily("pytest", msg, ruleId),
        mypy: (msg, ruleId) => classifyErrorFamily("mypy", msg, ruleId),
        pylint: (msg, ruleId) => classifyErrorFamily("pylint", msg, ruleId),
    },
    reducerFamilies: ["pytest", "lint", "mypy", "pylint", "python-unittest", "coverage"],
    fastPathPatterns: [
        {
            name: "python_traceback",
            regex: /(?:Traceback \(most recent call last\)|(\w+Error): .+)/,
            scope_tags: ["error-catalog"],
            constraint_kind: "hard",
        },
        {
            name: "ruff_rule",
            regex: /\bruff\s+([A-Z]\d{3,4})\b/i,
            scope_tags: ["linter-rules"],
            constraint_kind: "guiding",
            queryTransform: (m) => `Ruff linter rule ${m[1]}`,
        },
    ],
    verificationCommands: [
        { tool: "ruff", command: "ruff check .", description: "Lint with Ruff" },
        { tool: "ruff-format", command: "ruff format --check .", description: "Check formatting with Ruff" },
        { tool: "mypy", command: "mypy .", description: "Type-check with mypy" },
        { tool: "pytest", command: "pytest --tb=short", description: "Run pytest" },
    ],
    fixRecipes: [
        {
            errorFamily: "unused_import",
            template: "Remove the unused import from {file} or add it to __all__ if re-exported.",
            description: "An import brings in a name that is never used",
        },
        {
            errorFamily: "type_mismatch",
            template: "Fix the assignment in {file} to match the declared type, or add an explicit cast.",
            description: "Assigned value type incompatible with declared variable type",
        },
        {
            errorFamily: "import_error",
            template: "Verify the module path and ensure the package is installed: pip show {module}",
            description: "Module required by code or test cannot be imported",
        },
        {
            errorFamily: "assertion_failure",
            template: "Check the expected value in the assertion — update the test or fix the implementation.",
            description: "Test assertion evaluated to False",
        },
        {
            errorFamily: "unused_variable",
            template: "Remove the variable or prefix with _ if intentionally unused in {file}.",
            description: "Variable is assigned but never read",
        },
        {
            errorFamily: "fixture_error",
            template: "Fix the pytest fixture in {file}: spelling, conftest.py placement, and scope.",
            description: "Pytest fixture not found or has scope conflict.",
            steps: [
                "Check fixture name spelling",
                "Verify conftest.py location",
                "Check scope compatibility",
            ],
            constraints: "Keep fixtures in closest conftest.",
        },
        {
            errorFamily: "attribute_error",
            template: "Confirm the object type in {file}; guard against None and use hasattr or try/except as needed.",
            description: "Object does not have expected attribute or method.",
            steps: [
                "Verify object type",
                "Check for None",
                "Use hasattr or try/except",
            ],
            constraints: "Prefer duck typing checks.",
        },
        {
            errorFamily: "key_error",
            template: "Use safe dict access in {file}: .get(), explicit key checks, or defaultdict.",
            description: "Dictionary accessed with missing key.",
            steps: [
                "Use .get() with default",
                "Check key existence",
                "Use defaultdict",
            ],
            constraints: "Prefer .get() over try/except for simple lookups.",
        },
        {
            errorFamily: "type_annotation",
            template: "Add type hints in {file}; use typing for complex shapes and validate with mypy.",
            description: "Function or parameter missing type annotation.",
            steps: [
                "Add type hints",
                "Use typing module for complex types",
                "Run mypy",
            ],
            constraints: "Use modern syntax (X | Y not Union).",
        },
        {
            errorFamily: "return_type",
            template: "Align returns in {file} with the annotation on every path; use overloads if multiple shapes are valid.",
            description: "Returned value type incompatible with annotation.",
            steps: [
                "Verify return type",
                "Check all code paths",
                "Use overloads for multiple returns",
            ],
            constraints: "Avoid # type: ignore.",
        },
        {
            errorFamily: "security",
            template: "Remove unsafe patterns in {file}: replace eval, load secrets from env, parameterize queries.",
            description: "Potentially unsafe pattern (exec, eval, hardcoded password).",
            steps: [
                "Replace eval with ast.literal_eval",
                "Use environment variables for secrets",
                "Parameterize queries",
            ],
            constraints: "Never suppress security warnings.",
        },
        {
            errorFamily: "bugbear",
            template: "Address the Ruff/flake8-bugbear B-code in {file} using the rule’s recommended fix.",
            description: "Likely bug or footgun pattern detected.",
            steps: ["Review the specific B0xx code", "Apply the recommended fix"],
            constraints: "Treat B-codes as real bugs not style.",
        },
    ],
    corpusPackId: "lang-python",
};
