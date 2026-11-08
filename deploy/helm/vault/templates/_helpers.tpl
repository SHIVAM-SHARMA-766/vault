{{- define "vault.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "vault.labels" -}}
app.kubernetes.io/name: vault
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
{{- define "vault.selector" -}}
app.kubernetes.io/name: vault
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
