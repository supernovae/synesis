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

{{- define "synesis.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/part-of: synesis
{{- end -}}

{{- define "synesis.namespace" -}}
{{- $root := .root -}}
{{- $key := .key -}}
{{- index $root.Values.namespaces $key | default $key -}}
{{- end -}}

{{- define "synesis.host" -}}
{{- $host := .host | default "" -}}
{{- if and (not $host) .name .root.Values.global.routeDomain -}}
{{- printf "%s.%s" .name .root.Values.global.routeDomain -}}
{{- else -}}
{{- $host -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.adminHost" -}}
{{- if eq .Values.postgres.mode "cloudnativepg" -}}
{{- printf "%s-rw.%s.svc" .Values.postgres.cloudnativepg.admin.name .Values.namespaces.admin -}}
{{- else -}}
{{- .Values.postgres.external.admin.host -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.keycloakHost" -}}
{{- if eq .Values.postgres.mode "cloudnativepg" -}}
{{- printf "%s-rw.%s.svc" .Values.postgres.cloudnativepg.keycloak.name .Values.namespaces.auth -}}
{{- else -}}
{{- .Values.postgres.external.keycloak.host -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.openfgaHost" -}}
{{- if eq .Values.postgres.mode "cloudnativepg" -}}
{{- printf "%s-rw.%s.svc" .Values.postgres.cloudnativepg.openfga.name .Values.namespaces.authz -}}
{{- else -}}
{{- .Values.postgres.external.openfga.host -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.adminPassword" -}}
{{- if eq .Values.postgres.mode "cloudnativepg" -}}
{{- .Values.postgres.cloudnativepg.admin.password -}}
{{- else -}}
{{- .Values.postgres.external.admin.password -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.keycloakPassword" -}}
{{- if eq .Values.postgres.mode "cloudnativepg" -}}
{{- .Values.postgres.cloudnativepg.keycloak.password -}}
{{- else -}}
{{- .Values.postgres.external.keycloak.password -}}
{{- end -}}
{{- end -}}

{{- define "synesis.postgres.openfgaPassword" -}}
{{- if eq .Values.postgres.mode "cloudnativepg" -}}
{{- .Values.postgres.cloudnativepg.openfga.password -}}
{{- else -}}
{{- .Values.postgres.external.openfga.password -}}
{{- end -}}
{{- end -}}

{{- define "synesis.kvUrl" -}}
{{- if eq .Values.kv.mode "external" -}}
{{- .Values.kv.external.url -}}
{{- else -}}
{{- .Values.kv.redkey.url -}}
{{- end -}}
{{- end -}}
