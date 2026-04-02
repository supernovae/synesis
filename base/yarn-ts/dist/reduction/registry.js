import { classifyReducerFamily } from "./classifier.js";
import { AnsibleReducer } from "./reducers/ansible.js";
import { AptPkgReducer } from "./reducers/apt-pkg.js";
import { AwsCliReducer } from "./reducers/aws-cli.js";
import { AzCliReducer } from "./reducers/az-cli.js";
import { CargoReducer } from "./reducers/cargo.js";
import { ClippyReducer } from "./reducers/clippy.js";
import { CmakeReducer } from "./reducers/cmake.js";
import { ComposerReducer } from "./reducers/composer.js";
import { CoverageReducer } from "./reducers/coverage.js";
import { CppcheckReducer } from "./reducers/cppcheck.js";
import { CurlHttpReducer } from "./reducers/curl-http.js";
import { DockerBuildReducer } from "./reducers/docker-build.js";
import { DockerComposeReducer } from "./reducers/docker-compose.js";
import { DotnetReducer } from "./reducers/dotnet.js";
import { EsbuildReducer } from "./reducers/esbuild.js";
import { GcloudReducer } from "./reducers/gcloud.js";
import { GitDiffReducer } from "./reducers/git-diff.js";
import { GitLogReducer } from "./reducers/git-log.js";
import { GitReducer } from "./reducers/git.js";
import { GoBuildReducer } from "./reducers/go-build.js";
import { GradleReducer } from "./reducers/gradle.js";
import { HelmReducer } from "./reducers/helm.js";
import { JavaBuildReducer } from "./reducers/java-build.js";
import { JestReducer } from "./reducers/jest.js";
import { KubectlReducer } from "./reducers/kubectl.js";
import { LintReducer } from "./reducers/lint.js";
import { LogStreamReducer } from "./reducers/log-stream.js";
import { LsTreeReducer } from "./reducers/ls-tree.js";
import { MakeReducer } from "./reducers/make.js";
import { MochaReducer } from "./reducers/mocha.js";
import { MypyReducer } from "./reducers/mypy.js";
import { NetworkDiagReducer } from "./reducers/network-diag.js";
import { NpmAuditReducer } from "./reducers/npm-audit.js";
import { NpmInstallReducer } from "./reducers/npm-install.js";
import { OcReducer } from "./reducers/oc.js";
import { PhpunitReducer } from "./reducers/phpunit.js";
import { PipInstallReducer } from "./reducers/pip-install.js";
import { PnpmReducer } from "./reducers/pnpm.js";
import { PodmanReducer } from "./reducers/podman.js";
import { PylintReducer } from "./reducers/pylint.js";
import { PytestReducer } from "./reducers/pytest.js";
import { PythonUnittestReducer } from "./reducers/python-unittest.js";
import { RspecReducer } from "./reducers/rspec.js";
import { RubocopReducer } from "./reducers/rubocop.js";
import { SearchReducer } from "./reducers/search.js";
import { ShellcheckReducer } from "./reducers/shellcheck.js";
import { SqlResultReducer } from "./reducers/sql-result.js";
import { StackTraceReducer } from "./reducers/stack-trace.js";
import { StracePerfReducer } from "./reducers/strace-perf.js";
import { SwiftBuildReducer } from "./reducers/swift-build.js";
import { TerraformReducer } from "./reducers/terraform.js";
import { TscReducer } from "./reducers/tsc.js";
import { ViteReducer } from "./reducers/vite.js";
import { WebpackReducer } from "./reducers/webpack.js";
import { YarnInstallReducer } from "./reducers/yarn-install.js";
const REDUCERS = {
    // Original 25
    pytest: new PytestReducer(),
    tsc: new TscReducer(),
    lint: new LintReducer(),
    git: new GitReducer(),
    search: new SearchReducer(),
    "npm-install": new NpmInstallReducer(),
    "docker-build": new DockerBuildReducer(),
    cargo: new CargoReducer(),
    make: new MakeReducer(),
    "stack-trace": new StackTraceReducer(),
    jest: new JestReducer(),
    "go-build": new GoBuildReducer(),
    "pip-install": new PipInstallReducer(),
    "ls-tree": new LsTreeReducer(),
    "curl-http": new CurlHttpReducer(),
    kubectl: new KubectlReducer(),
    terraform: new TerraformReducer(),
    "sql-result": new SqlResultReducer(),
    mypy: new MypyReducer(),
    "java-build": new JavaBuildReducer(),
    ansible: new AnsibleReducer(),
    helm: new HelmReducer(),
    "network-diag": new NetworkDiagReducer(),
    "strace-perf": new StracePerfReducer(),
    "log-stream": new LogStreamReducer(),
    // Batch 3: container/infra + version control
    "git-diff": new GitDiffReducer(),
    podman: new PodmanReducer(),
    oc: new OcReducer(),
    "docker-compose": new DockerComposeReducer(),
    coverage: new CoverageReducer(),
    // Batch 4: cloud CLIs + audit
    "aws-cli": new AwsCliReducer(),
    gcloud: new GcloudReducer(),
    "az-cli": new AzCliReducer(),
    "npm-audit": new NpmAuditReducer(),
    webpack: new WebpackReducer(),
    // Batch 5: JS build + package managers
    vite: new ViteReducer(),
    esbuild: new EsbuildReducer(),
    "yarn-install": new YarnInstallReducer(),
    pnpm: new PnpmReducer(),
    "apt-pkg": new AptPkgReducer(),
    // Batch 6: test runners
    mocha: new MochaReducer(),
    rspec: new RspecReducer(),
    phpunit: new PhpunitReducer(),
    "python-unittest": new PythonUnittestReducer(),
    dotnet: new DotnetReducer(),
    // Batch 7: linters + static analysis
    pylint: new PylintReducer(),
    shellcheck: new ShellcheckReducer(),
    clippy: new ClippyReducer(),
    rubocop: new RubocopReducer(),
    cppcheck: new CppcheckReducer(),
    // Batch 8: remaining build + VCS
    gradle: new GradleReducer(),
    "swift-build": new SwiftBuildReducer(),
    cmake: new CmakeReducer(),
    composer: new ComposerReducer(),
    "git-log": new GitLogReducer(),
};
export function registeredFamilies() {
    return Object.keys(REDUCERS);
}
export class ReducerRegistry {
    options;
    lifecycle = new Map();
    constructor(options) {
        this.options = options;
        registeredFamilies().forEach((family) => {
            this.lifecycle.set(family, { lifecycle: options.disabledFamilies.has(family) ? "disabled" : "enabled", successes: 0, failures: 0 });
        });
    }
    reduce(input) {
        if (!this.options.enabled)
            return null;
        const family = classifyReducerFamily(input.context.toolName, input.context.command, input.raw);
        if (family === "generic" || this.options.disabledFamilies.has(family))
            return null;
        const reducer = REDUCERS[family];
        if (!reducer)
            return null;
        const state = this.lifecycle.get(family);
        if (state?.lifecycle === "disabled")
            return null;
        try {
            const out = reducer.reduce(input);
            if (!out)
                return null;
            if (out.confidence < this.options.minConfidence) {
                return null;
            }
            if (state) {
                state.successes += 1;
                if (state.lifecycle === "degraded" && state.successes > state.failures * 2) {
                    state.lifecycle = "enabled";
                }
            }
            return out;
        }
        catch (error) {
            if (state) {
                state.failures += 1;
                state.lastError = String(error);
                if (state.failures >= 3 && state.failures > state.successes) {
                    state.lifecycle = "degraded";
                }
            }
            return null;
        }
    }
    lifecycleStates() {
        return Object.fromEntries(this.lifecycle.entries());
    }
}
