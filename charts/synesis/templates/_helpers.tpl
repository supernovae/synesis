{{/*
Common names and labels.
*/}}
{{- define "synesis.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "synesis.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "synesis.name" . -}}
{{- end -}}
{{- end -}}

{{- define "synesis.labels" -}}
app.kubernetes.io/part-of: synesis
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "synesis.secretLooksPlaceholder" -}}
{{- $value := lower (trim (toString .)) -}}
{{- if or (eq $value "") (eq $value "changeme") (contains "change-me" $value) (contains "replace_me" $value) -}}
true
{{- else -}}
false
{{- end -}}
{{- end -}}

{{- define "synesis.requireNonPlaceholderSecret" -}}
{{- $root := .root -}}
{{- if not $root.Values.global.allowInsecureDefaults -}}
{{- $name := .name -}}
{{- $value := .value -}}
{{- if eq (include "synesis.secretLooksPlaceholder" $value) "true" -}}
{{- fail (printf "%s must be set to a non-placeholder value, or set global.allowInsecureDefaults=true only for disposable local/demo renders" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "synesis.validateProductionSecrets" -}}
{{- include "synesis.requireNonPlaceholderSecret" (dict "root" . "name" "secrets.internalServiceToken" "value" .Values.secrets.internalServiceToken) -}}
{{- include "synesis.requireNonPlaceholderSecret" (dict "root" . "name" "secrets.webuiSecretKey" "value" .Values.secrets.webuiSecretKey) -}}
{{- include "synesis.requireNonPlaceholderSecret" (dict "root" . "name" "secrets.openfgaAuthToken" "value" .Values.secrets.openfgaAuthToken) -}}
{{- include "synesis.requireNonPlaceholderSecret" (dict "root" . "name" "postgres admin password" "value" (include "synesis.postgres.adminPassword" .)) -}}
{{- include "synesis.requireNonPlaceholderSecret" (dict "root" . "name" "postgres keycloak password" "value" (include "synesis.postgres.keycloakPassword" .)) -}}
{{- include "synesis.requireNonPlaceholderSecret" (dict "root" . "name" "postgres openfga password" "value" (include "synesis.postgres.openfgaPassword" .)) -}}
{{- range $key, $value := .Values.secrets.providerApiKeys }}
{{- if $value }}
{{- include "synesis.requireNonPlaceholderSecret" (dict "root" $ "name" (printf "secrets.providerApiKeys.%s" $key) "value" $value) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "synesis.validateProductionImages" -}}
{{- if not .Values.global.allowInsecureDefaults -}}
{{- if eq (lower (toString .Values.global.imageTag)) "latest" -}}
{{- fail "global.imageTag must not be latest for production renders, or set global.allowInsecureDefaults=true only for disposable local/demo renders" -}}
{{- end -}}
{{- range $key, $workload := .Values.workloads }}
{{- if and $workload.enabled $workload.image $workload.image.tag (eq (lower (toString $workload.image.tag)) "latest") -}}
{{- fail (printf "workloads.%s.image.tag must not be latest for production renders, or set global.allowInsecureDefaults=true only for disposable local/demo renders" $key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "synesis.imagePullSecrets" -}}
{{- $secrets := list -}}
{{- range .Values.global.imagePullSecrets }}
{{- $secrets = append $secrets . -}}
{{- end }}
{{- if .Values.registryCredentials.enabled }}
{{- $secrets = append $secrets (dict "name" .Values.registryCredentials.name) -}}
{{- end }}
{{- if $secrets }}
imagePullSecrets:
{{- toYaml $secrets | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
Merge architecture nodeSelector: workload-level > global.architecture.
Returns the combined nodeSelector map as YAML.
*/}}
{{- define "synesis.nodeSelector" -}}
{{- $workload := .workload -}}
{{- $root := .root -}}
{{- $amd64Only := .amd64Only | default false -}}
{{- $merged := dict -}}
{{- if $root.Values.global.architecture }}
{{- $_ := set $merged "kubernetes.io/arch" $root.Values.global.architecture -}}
{{- end }}
{{- if $amd64Only }}
{{- $_ := set $merged "kubernetes.io/arch" "amd64" -}}
{{- end }}
{{- if $workload.nodeSelector }}
{{- $merged = merge $workload.nodeSelector $merged -}}
{{- end }}
{{- if $merged }}
nodeSelector:
  {{- toYaml $merged | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "synesis.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/part-of: synesis
{{- end -}}

{{- define "synesis.namespace" -}}
{{- $root := .root -}}
{{- $key := .key -}}
{{- index $root.Values.namespaces $key | default $key -}}
{{- end -}}

{{- define "synesis.nornicAuthSecretName" -}}
{{- $nornicdb := index .Values "nornicdb" | default dict -}}
{{- $auth := index $nornicdb "auth" | default dict -}}
{{- index $auth "secretName" | default "synesis-nornicdb-auth" -}}
{{- end -}}

{{- define "synesis.nornicAuthUsername" -}}
{{- $nornicdb := index .Values "nornicdb" | default dict -}}
{{- $auth := index $nornicdb "auth" | default dict -}}
{{- index $auth "username" | default "neo4j" -}}
{{- end -}}

{{- define "synesis.host" -}}
{{- $host := .host | default "" -}}
{{- if and (not $host) .name .root.Values.global.routeDomain -}}
{{- printf "%s.%s" .name .root.Values.global.routeDomain -}}
{{- else -}}
{{- $host -}}
{{- end -}}
{{- end -}}

{{- define "synesis.provider" -}}
{{- $provider := lower (default "openshift" .Values.global.provider) -}}
{{- if eq $provider "auto" -}}
{{- $gitVersion := lower (.Capabilities.KubeVersion.GitVersion | default "") -}}
{{- if .Capabilities.APIVersions.Has "route.openshift.io/v1/Route" -}}
openshift
{{- else if contains "aks" $gitVersion -}}
aks
{{- else if contains "eks" $gitVersion -}}
eks
{{- else if contains "gke" $gitVersion -}}
gke
{{- else -}}
kubernetes
{{- end -}}
{{- else -}}
{{- $provider -}}
{{- end -}}
{{- end -}}

{{- define "synesis.isOpenShift" -}}
{{- $provider := include "synesis.provider" . -}}
{{- if eq $provider "openshift" -}}
true
{{- else -}}
false
{{- end -}}
{{- end -}}

{{- define "synesis.olmEnabled" -}}
{{- if kindIs "bool" .Values.operators.installWithOLM -}}
{{- .Values.operators.installWithOLM -}}
{{- else if eq (lower (toString .Values.operators.installWithOLM)) "auto" -}}
{{- if or (eq (include "synesis.isOpenShift" .) "true") (.Capabilities.APIVersions.Has "operators.coreos.com/v1alpha1/Subscription") -}}
true
{{- else -}}
false
{{- end -}}
{{- else -}}
{{- .Values.operators.installWithOLM -}}
{{- end -}}
{{- end -}}

{{- define "synesis.operatorCustomResourceReady" -}}
{{- $root := .root -}}
{{- $gvk := .apiVersion -}}
{{- $mode := lower (toString (default "auto" $root.Values.operators.customResources.create)) -}}
{{- if or (eq $mode "always") (eq $mode "true") -}}
true
{{- else if or (eq $mode "never") (eq $mode "false") -}}
false
{{- else if eq $mode "auto" -}}
{{- if $root.Capabilities.APIVersions.Has $gvk -}}
true
{{- else -}}
false
{{- end -}}
{{- else -}}
{{- fail (printf "operators.customResources.create must be one of auto, always, or never; got %q" $mode) -}}
{{- end -}}
{{- end -}}

{{- define "synesis.providerStorageClass" -}}
{{- $provider := include "synesis.provider" . -}}
{{- if eq $provider "aks" -}}
{{- .Values.platform.aks.storageClass -}}
{{- else if eq $provider "eks" -}}
{{- .Values.platform.eks.storageClass -}}
{{- else if eq $provider "gke" -}}
{{- .Values.platform.gke.storageClass -}}
{{- else if eq $provider "openshift" -}}
{{- .Values.platform.openshift.storageClass -}}
{{- else -}}
{{- .Values.platform.kubernetes.storageClass -}}
{{- end -}}
{{- end -}}

{{- define "synesis.storageClass" -}}
{{- $root := .root -}}
{{- $key := .key | default "" -}}
{{- $explicit := .storageClass | default "" -}}
{{- if $explicit -}}
{{- $explicit -}}
{{- else if and (eq $key "postgres") $root.Values.platform.storage.postgresClass -}}
{{- $root.Values.platform.storage.postgresClass -}}
{{- else if and (eq $key "webui") $root.Values.platform.storage.webuiClass -}}
{{- $root.Values.platform.storage.webuiClass -}}
{{- else if and (eq $key "nornicdb") $root.Values.platform.storage.nornicdbClass -}}
{{- $root.Values.platform.storage.nornicdbClass -}}
{{- else if $root.Values.platform.storage.defaultClass -}}
{{- $root.Values.platform.storage.defaultClass -}}
{{- else if $root.Values.platform.storage.useProviderDefaults -}}
{{- include "synesis.providerStorageClass" $root -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.adminHost" -}}
{{- if eq .Values.postgres.mode "cloudnativepg" -}}
{{- printf "%s-rw.%s.svc" .Values.postgres.cloudnativepg.admin.name .Values.namespaces.admin -}}
{{- else if eq .Values.postgres.mode "azureFlexible" -}}
{{- .Values.postgres.azureFlexible.host -}}
{{- else -}}
{{- .Values.postgres.external.admin.host -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.keycloakHost" -}}
{{- if eq .Values.postgres.mode "cloudnativepg" -}}
{{- printf "%s-rw.%s.svc" .Values.postgres.cloudnativepg.keycloak.name .Values.namespaces.auth -}}
{{- else if eq .Values.postgres.mode "azureFlexible" -}}
{{- .Values.postgres.azureFlexible.host -}}
{{- else -}}
{{- .Values.postgres.external.keycloak.host -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.openfgaHost" -}}
{{- if eq .Values.postgres.mode "cloudnativepg" -}}
{{- printf "%s-rw.%s.svc" .Values.postgres.cloudnativepg.openfga.name .Values.namespaces.authz -}}
{{- else if eq .Values.postgres.mode "azureFlexible" -}}
{{- .Values.postgres.azureFlexible.host -}}
{{- else -}}
{{- .Values.postgres.external.openfga.host -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.database" -}}
{{- $root := .root -}}
{{- $key := .key -}}
{{- if eq $root.Values.postgres.mode "cloudnativepg" -}}
{{- (index $root.Values.postgres.cloudnativepg $key).database -}}
{{- else if eq $root.Values.postgres.mode "azureFlexible" -}}
{{- (index $root.Values.postgres.azureFlexible $key).database -}}
{{- else -}}
{{- (index $root.Values.postgres.external $key).database -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.username" -}}
{{- $root := .root -}}
{{- $key := .key -}}
{{- if eq $root.Values.postgres.mode "cloudnativepg" -}}
{{- (index $root.Values.postgres.cloudnativepg $key).owner -}}
{{- else if eq $root.Values.postgres.mode "azureFlexible" -}}
{{- (index $root.Values.postgres.azureFlexible $key).username -}}
{{- else -}}
{{- (index $root.Values.postgres.external $key).username -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.port" -}}
{{- $root := .root -}}
{{- $key := .key -}}
{{- if eq $root.Values.postgres.mode "cloudnativepg" -}}
5432
{{- else if eq $root.Values.postgres.mode "azureFlexible" -}}
{{- $root.Values.postgres.azureFlexible.port | int -}}
{{- else -}}
{{- (index $root.Values.postgres.external $key).port | int -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.sslmode" -}}
{{- $root := .root -}}
{{- $key := .key -}}
{{- if eq $root.Values.postgres.mode "cloudnativepg" -}}
disable
{{- else if eq $root.Values.postgres.mode "azureFlexible" -}}
{{- $root.Values.postgres.azureFlexible.sslmode -}}
{{- else -}}
{{- (index $root.Values.postgres.external $key).sslmode -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.adminPassword" -}}
{{- if eq .Values.postgres.mode "cloudnativepg" -}}
{{- .Values.postgres.cloudnativepg.admin.password -}}
{{- else if eq .Values.postgres.mode "azureFlexible" -}}
{{- .Values.postgres.azureFlexible.admin.password -}}
{{- else -}}
{{- .Values.postgres.external.admin.password -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.keycloakPassword" -}}
{{- if eq .Values.postgres.mode "cloudnativepg" -}}
{{- .Values.postgres.cloudnativepg.keycloak.password -}}
{{- else if eq .Values.postgres.mode "azureFlexible" -}}
{{- .Values.postgres.azureFlexible.keycloak.password -}}
{{- else -}}
{{- .Values.postgres.external.keycloak.password -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.openfgaPassword" -}}
{{- if eq .Values.postgres.mode "cloudnativepg" -}}
{{- .Values.postgres.cloudnativepg.openfga.password -}}
{{- else if eq .Values.postgres.mode "azureFlexible" -}}
{{- .Values.postgres.azureFlexible.openfga.password -}}
{{- else -}}
{{- .Values.postgres.external.openfga.password -}}
{{- end -}}
{{- end -}}

{{- define "synesis.kvUrl" -}}
{{- if eq .Values.kv.mode "external" -}}
{{- .Values.kv.external.url -}}
{{- else if eq .Values.kv.mode "azureRedis" -}}
{{- if .Values.kv.azureRedis.url -}}
{{- .Values.kv.azureRedis.url -}}
{{- else -}}
{{- $scheme := ternary "rediss" "redis" .Values.kv.azureRedis.tls -}}
{{- $auth := "" -}}
{{- if .Values.kv.azureRedis.password -}}
{{- if .Values.kv.azureRedis.username -}}
{{- $auth = printf "%s:%s@" (.Values.kv.azureRedis.username | urlquery) (.Values.kv.azureRedis.password | urlquery) -}}
{{- else -}}
{{- $auth = printf ":%s@" (.Values.kv.azureRedis.password | urlquery) -}}
{{- end -}}
{{- end -}}
{{- printf "%s://%s%s:%v/%v" $scheme $auth .Values.kv.azureRedis.host (.Values.kv.azureRedis.port | int) (.Values.kv.azureRedis.database | int) -}}
{{- end -}}
{{- else -}}
{{- .Values.kv.redkey.url -}}
{{- end -}}
{{- end -}}
