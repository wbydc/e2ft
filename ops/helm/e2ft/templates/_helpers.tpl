{{- define "e2ft.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "e2ft.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "e2ft.selector" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "e2ft.coturnSelector" -}}
app.kubernetes.io/name: coturn
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The Secret and key holding the TURN shared secret. */}}
{{- define "e2ft.secretName" -}}
{{- .Values.turn.existingSecret | default (printf "%s-turn" (include "e2ft.fullname" .)) -}}
{{- end -}}

{{- define "e2ft.secretKey" -}}
{{- if .Values.turn.existingSecret }}{{ .Values.turn.existingSecretKey }}{{ else }}secret{{ end -}}
{{- end -}}

{{- define "e2ft.turnUrls" -}}
{{- if .Values.turn.urls -}}
{{- join "," .Values.turn.urls -}}
{{- else if .Values.coturn.enabled -}}
{{- $base := printf "turn:%s:%d" .Values.coturn.host (int .Values.coturn.port) -}}
{{- printf "%s?transport=udp,%s?transport=tcp" $base $base -}}
{{- end -}}
{{- end -}}

{{- define "e2ft.stunUrls" -}}
{{- if .Values.turn.stunUrls -}}
{{- join "," .Values.turn.stunUrls -}}
{{- else if .Values.coturn.enabled -}}
{{- printf "stun:%s:%d" .Values.coturn.host (int .Values.coturn.port) -}}
{{- end -}}
{{- end -}}

{{/* Fails the render on settings that cannot work. */}}
{{- define "e2ft.validate" -}}
{{- if .Values.coturn.enabled -}}
{{- if not .Values.coturn.host -}}{{- fail "coturn.host is required when coturn.enabled" -}}{{- end -}}
{{- if not (has .Values.coturn.mode (list "hostNetwork" "loadBalancer")) -}}
{{- fail "coturn.mode must be hostNetwork or loadBalancer" -}}
{{- end -}}
{{- if and (eq .Values.coturn.mode "loadBalancer") (not .Values.coturn.externalIp) -}}
{{- fail "coturn.externalIp (the load balancer's public address) is required in loadBalancer mode" -}}
{{- end -}}
{{- if gt (int .Values.coturn.minPort) (int .Values.coturn.maxPort) -}}{{- fail "coturn.minPort is above coturn.maxPort" -}}{{- end -}}
{{- end -}}
{{- if and (include "e2ft.turnUrls" .) (not .Values.turn.secret) (not .Values.turn.existingSecret) -}}
{{- fail "TURN needs turn.secret or turn.existingSecret" -}}
{{- end -}}
{{- if and .Values.turn.secret (lt (len .Values.turn.secret) 32) -}}
{{- fail "turn.secret must be at least 32 characters" -}}
{{- end -}}
{{- end -}}
