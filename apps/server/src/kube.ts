// 쿠버네티스 API에 붙을 설정을 고릅니다(docs/guides/T12.md 결정 4).
// 클러스터 밖에서는 정해 준 context만 쓰고, kubeconfig의 current-context는 따라가지 않습니다.
import { ApiException, KubeConfig } from "@kubernetes/client-node";

type Env = Record<string, string | undefined>;

export type KubeSource =
  | { kind: "kubeconfig"; context: string }
  | { kind: "in-cluster" }
  | { kind: "disabled"; reason: string };

export interface KubeConnection {
  config: KubeConfig;
  source: "kubeconfig" | "in-cluster";
  // kubeconfig에서 고른 context입니다. 클러스터 안이면 없습니다.
  context: string | undefined;
  // 로그에 남길 API 서버 주소입니다. 어느 클러스터를 보는지 바로 알 수 있게 합니다.
  server: string;
}

// 오류 설명은 로그 한 줄에 들어가도록 이 길이까지만 씁니다.
const MAX_DETAIL_LENGTH = 200;

export function chooseKubeSource(
  context: string | undefined,
  env: Env,
): KubeSource {
  if (context !== undefined) {
    return { kind: "kubeconfig", context };
  }
  // 쿠버네티스가 모든 컨테이너에 넣어 주는 환경변수입니다.
  if (env["KUBERNETES_SERVICE_HOST"]) {
    return { kind: "in-cluster" };
  }
  return {
    kind: "disabled",
    reason: "GLASSPOD_KUBE_CONTEXT is not set and not running in a cluster",
  };
}

// 고른 설정으로 KubeConfig를 만듭니다. kubeconfig에 그 context가 없으면 예외를 던집니다(시작 실패).
export function loadKubeConfig(
  source: Exclude<KubeSource, { kind: "disabled" }>,
): KubeConnection {
  const config = new KubeConfig();
  if (source.kind === "in-cluster") {
    config.loadFromCluster();
  } else {
    config.loadFromDefault();
    // setCurrentContext()는 이름을 검사하지 않으므로 먼저 찾아 봅니다.
    if (config.getContextObject(source.context) === null) {
      throw new Error(`context "${source.context}" not found in kubeconfig`);
    }
    config.setCurrentContext(source.context);
  }
  const cluster = config.getCurrentCluster();
  if (cluster === null) {
    throw new Error(
      source.kind === "in-cluster"
        ? "in-cluster configuration has no cluster"
        : `context "${source.context}" has no cluster in kubeconfig`,
    );
  }
  return {
    config,
    source: source.kind,
    context: source.kind === "kubeconfig" ? source.context : undefined,
    server: cluster.server,
  };
}

function truncate(text: string): string {
  return text.length > MAX_DETAIL_LENGTH
    ? `${text.slice(0, MAX_DETAIL_LENGTH)}…`
    : text;
}

// 원인 오류(cause)에서 짧은 설명을 꺼냅니다. localhost처럼 주소가 둘이면 AggregateError로 옵니다.
function describeCause(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) {
    return undefined;
  }
  if (cause.message !== "") {
    return cause.message;
  }
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string") {
    return code;
  }
  if (cause instanceof AggregateError) {
    return describeCause(cause.errors[0]);
  }
  return undefined;
}

// list·watch 실패를 로그 한 줄의 설명으로 바꿉니다.
// HTTP 오류는 상태 코드만(본문에 요청 정보가 들어 있어 길어짐), 네트워크 오류는 원인까지 씁니다.
export function describeError(error: unknown): string {
  if (error instanceof ApiException) {
    return `http ${error.code}`;
  }
  if (error instanceof Error) {
    // watch 요청이 200이 아니면 statusCode를 붙인 Error가 옵니다.
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") {
      return `http ${statusCode}`;
    }
    const cause = describeCause(error.cause);
    return truncate(
      cause === undefined ? error.message : `${error.message}: ${cause}`,
    );
  }
  return truncate(String(error));
}
