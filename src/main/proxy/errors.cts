export interface OcxErrorPayload {
  message: string;
  type: string;
  code: string | null;
}

export function rawMessage(message: string): string {
  const text = message.trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const root = parsed as Record<string, unknown>;
      const error = root.error as Record<string, unknown> | undefined;
      const nested = error?.message ?? root.message ?? error?.code ?? error?.type;
      if (nested) return String(nested);
    }
  } catch {
    // Plain-text upstream error.
  }
  return text.replace(/\s+/g, " ");
}

function truncateRaw(raw: string): string {
  return raw ? ` 원문: ${raw.slice(0, 260)}` : "";
}

export function providerErrorMessage(provider: string, status: number, detail: string): string {
  const raw = rawMessage(detail);
  const suffix = truncateRaw(raw);
  const lower = raw.toLowerCase();
  if (status === 401) {
    if (lower.includes("token_revoked") || lower.includes("invalidated oauth token")) {
      return `${provider} 로그인 토큰이 만료되었거나 취소되었습니다. 설정 > 연결에서 로그아웃한 뒤 다시 로그인해 주세요.${suffix}`;
    }
    return `${provider} 인증이 만료되었거나 로그인 정보가 유효하지 않습니다. 설정에서 로그아웃 후 다시 로그인해 주세요.${suffix}`;
  }
  if (status === 403) {
    if (lower.includes("quota") || lower.includes("usage") || lower.includes("billing")) {
      return `${provider} 사용량/결제 한도 때문에 요청이 거부되었습니다. 사용량 및 청구 상태를 확인해 주세요.${suffix}`;
    }
    return `${provider}가 이 모델 접근을 거부했습니다. 현재 계정/구독에서 지원하지 않는 모델이거나 권한이 부족할 수 있습니다.${suffix}`;
  }
  if (status === 404) {
    return `${provider}가 이 모델을 현재 API 경로에서 찾지 못했습니다. 모델 목록에는 보여도 대화 API에서 아직 지원하지 않을 수 있습니다.${suffix}`;
  }
  if (status === 400) {
    if (lower.includes("model") && (lower.includes("not supported") || lower.includes("unsupported"))) {
      return `${provider}가 이 모델을 현재 계정/API 경로에서 지원하지 않습니다. 모델 목록에는 보여도 실제 대화 호출은 막혀 있을 수 있습니다.${suffix}`;
    }
    if (
      lower.includes("context_length_exceeded") ||
      lower.includes("context window") ||
      lower.includes("context length") ||
      lower.includes("maximum context") ||
      lower.includes("too many tokens")
    ) {
      return `${provider} 컨텍스트 길이 한도를 넘었습니다. 대화가 너무 길거나 첨부/툴 결과가 커서 모델이 받을 수 없습니다.${suffix}`;
    }
    return `${provider}가 요청을 거절했습니다. 이 모델이 현재 메시지/툴/컨텍스트 조합을 지원하지 않거나 요청 형식이 맞지 않을 수 있습니다.${suffix}`;
  }
  if (status === 429) {
    return `${provider} 사용량 제한에 걸렸습니다. 잠시 후 다시 시도해 주세요.${suffix}`;
  }
  if (status >= 500) {
    return `${provider} 서버 쪽 오류입니다. 일시적인 장애이거나 해당 모델이 현재 불안정할 수 있습니다.${suffix}`;
  }
  return `${provider} 요청 실패 (${status}).${suffix}`;
}

export function providerRuntimeErrorMessage(provider: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const raw = rawMessage(message);
  const lower = raw.toLowerCase();
  const status = raw.match(/\b(400|401|403|404|408|409|429|5\d\d)\b/)?.[1];
  if (status) return providerErrorMessage(provider, Number(status), raw);
  if (
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("und_err") ||
    lower.includes("socket") ||
    lower.includes("connection")
  ) {
    return `${provider} 네트워크 연결에 실패했습니다. 인터넷 연결, VPN/프록시, provider 서버 상태를 확인해 주세요.${truncateRaw(raw)}`;
  }
  if (lower.includes("token_revoked") || lower.includes("invalidated oauth token")) {
    return `${provider} 로그인 토큰이 만료되었거나 취소되었습니다. 설정 > 연결에서 로그아웃한 뒤 다시 로그인해 주세요.${truncateRaw(raw)}`;
  }
  if (lower.includes("api key") || lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("invalid token")) {
    return `${provider} 인증 정보가 없거나 유효하지 않습니다. 설정의 Provider 연결/API 키를 다시 확인해 주세요.${truncateRaw(raw)}`;
  }
  if (lower.includes("not supported") || lower.includes("unsupported model") || lower.includes("model_not_found") || lower.includes("model not found")) {
    return `${provider}가 현재 선택한 모델을 지원하지 않습니다. 모델 목록에는 보여도 현재 계정/API 경로에서 실제 호출이 막혀 있을 수 있습니다.${truncateRaw(raw)}`;
  }
  if (lower.includes("rate limit") || lower.includes("too many requests")) {
    return `${provider} 사용량 제한에 걸렸습니다. 잠시 후 다시 시도해 주세요.${truncateRaw(raw)}`;
  }
  if (lower.includes("quota") || lower.includes("billing") || lower.includes("insufficient")) {
    return `${provider} 사용량/결제 한도 때문에 요청이 실패했습니다. 사용량 및 청구 상태를 확인해 주세요.${truncateRaw(raw)}`;
  }
  if (lower.includes("empty response") || lower.includes("빈 응답")) {
    return `${provider}가 빈 응답을 반환했습니다. 모델이 계정에서 지원되지 않거나, 로그인/권한/컨텍스트 호환성 문제가 있을 수 있습니다.${truncateRaw(raw)}`;
  }
  return `${provider} 요청 실패: ${raw || "알 수 없는 오류"}`;
}

export function emptyAssistantOutputMessage(modelId: string): string {
  return `${modelId} 요청은 완료됐지만 assistant 본문이 오지 않았습니다. 모델이 현재 계정/구독, 컨텍스트 길이, 또는 Codex 툴 호출 형식과 호환되지 않을 수 있습니다. 작은 모델은 되고 이 모델만 실패한다면 모델 접근/호환성 문제일 가능성이 큽니다.`;
}

export function classifyError(status: number, type: string, message: string): OcxErrorPayload {
  const text = message.toLowerCase();
  if (type === "upstream_empty_response") {
    return { message, type: "server_error", code: "upstream_empty_response" };
  }
  if (
    text.includes("context_length_exceeded") ||
    text.includes("context window") ||
    text.includes("context length") ||
    text.includes("maximum context") ||
    text.includes("too many tokens")
  ) {
    return { message, type: "invalid_request_error", code: "context_length_exceeded" };
  }
  if (
    text.includes("insufficient_quota") ||
    text.includes("exceeded your current quota")
  ) {
    return { message, type: "insufficient_quota", code: "insufficient_quota" };
  }
  if (status === 429 || text.includes("rate limit") || text.includes("too many requests")) {
    return { message, type: "rate_limit_error", code: "rate_limit_exceeded" };
  }
  if (status === 401 || status === 403 || type === "authentication_error") {
    return { message, type: "authentication_error", code: status === 403 ? "permission_denied" : "invalid_api_key" };
  }
  if (status === 404 || text.includes("model_not_found") || text.includes("model not found")) {
    return { message, type: "invalid_request_error", code: "model_not_found" };
  }
  if (
    status === 503 ||
    text.includes("overloaded") ||
    text.includes("server is busy") ||
    text.includes("temporarily unavailable")
  ) {
    // Codex recognizes "server_is_overloaded" and applies retry-after backoff
    // (responses.rs is_server_overloaded_error); generic "upstream_server_error" is not recognized.
    return { message, type: "server_error", code: "server_is_overloaded" };
  }
  if (status >= 500) {
    return { message, type: "server_error", code: "upstream_server_error" };
  }
  if (status === 400 || type === "invalid_request_error") {
    return { message, type: "invalid_request_error", code: "invalid_request_error" };
  }
  return { message, type, code: type || null };
}
