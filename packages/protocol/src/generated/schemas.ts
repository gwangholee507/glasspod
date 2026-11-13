// 이 파일은 `npm run generate`가 만든 것입니다. 직접 고치지 마세요.
// 고칠 때는 스키마(schema/sdk-message.schema.json, schema/server-message.schema.json, schema/snapshot.schema.json)를 고친 뒤 다시 만듭니다.

// schema/sdk-message.schema.json
export const sdkMessageSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "SdkMessage",
  description:
    "SDK가 서버로 보내는 메시지입니다(design.md 7.3). type 값으로 종류를 나눕니다.",
  type: "object",
  required: ["type"],
  discriminator: {
    propertyName: "type",
  },
  oneOf: [
    {
      $ref: "#/definitions/Hello",
    },
    {
      $ref: "#/definitions/Metrics",
    },
    {
      $ref: "#/definitions/Event",
    },
    {
      $ref: "#/definitions/Response",
    },
  ],
  definitions: {
    Seq: {
      title: "Seq",
      description:
        "프로세스가 시작될 때 0부터 셉니다. SDK가 실제로 보낼 때 붙이므로 보낸 순서대로 늘어나고, 재연결해도 이어집니다. SDK는 보낸 메시지를 다시 보내지 않으므로 서버는 빈틈으로 누락을 알 수 있습니다.",
      type: "integer",
      minimum: 0,
    },
    Timestamp: {
      title: "Timestamp",
      description:
        "보낸 시각(epoch ms)입니다. event만은 일어난 시각입니다(묶어 보낸 event는 그 묶음에서 처음 일어난 것, 연결이 없는 동안 들고 있다가 보낸 event도 원래 시각). 서버는 받은 시각을 따로 기록합니다.",
      type: "integer",
      minimum: 0,
    },
    PodRef: {
      title: "PodRef",
      description:
        "Pod를 가리키는 키입니다. SDK는 Downward API로 받은 환경변수에서 읽습니다.",
      type: "object",
      required: ["namespace", "name"],
      properties: {
        namespace: {
          type: "string",
          minLength: 1,
        },
        name: {
          type: "string",
          minLength: 1,
        },
      },
    },
    Hello: {
      title: "HelloMessage",
      description:
        "연결 직후 한 번 보냅니다. 나는 누구인가(Pod, 인스턴스)를 알립니다.",
      type: "object",
      required: ["type", "seq", "ts", "protocol", "sdk", "pod", "instanceId"],
      properties: {
        type: {
          const: "hello",
        },
        seq: {
          $ref: "#/definitions/Seq",
        },
        ts: {
          $ref: "#/definitions/Timestamp",
        },
        protocol: {
          description:
            "프로토콜 버전입니다. 필드를 없애거나 의미를 바꿀 때만 올립니다.",
          type: "integer",
          minimum: 1,
        },
        sdk: {
          type: "object",
          required: ["lang", "version"],
          properties: {
            lang: {
              description: "SDK 언어입니다. 예: node",
              type: "string",
              minLength: 1,
            },
            version: {
              type: "string",
              minLength: 1,
            },
          },
        },
        pod: {
          $ref: "#/definitions/PodRef",
        },
        instanceId: {
          description:
            "SDK가 시작할 때 무작위로 만듭니다. Pod 이름은 같은데 instanceId가 바뀌었으면 컨테이너가 재시작된 것입니다.",
          type: "string",
          minLength: 1,
        },
        app: {
          description: "감시 대상 앱의 이름과 버전입니다.",
          type: "object",
          required: ["name"],
          properties: {
            name: {
              type: "string",
              minLength: 1,
            },
            version: {
              type: "string",
            },
          },
        },
        capabilities: {
          description:
            "이 SDK가 응답할 수 있는 요청(request의 action) 목록입니다. 예: snapshot",
          type: "array",
          items: {
            type: "string",
          },
        },
      },
    },
    MetricName: {
      title: "MetricName",
      description:
        "지표 이름입니다. 소문자, 숫자, _로 쓰고 단계는 .으로 나눕니다. 접두어로 출처를 구분합니다(runtime.*, http.*은 SDK 자동 수집, app.*은 개발자 등록).",
      type: "string",
      pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$",
    },
    MetricKind: {
      title: "MetricKind",
      description:
        "gauge는 지금 값, counter는 누적값입니다. counter 값이 줄어들면 서버는 프로세스가 재시작됐다고 판단합니다.",
      enum: ["gauge", "counter"],
    },
    MetricValue: {
      title: "MetricValue",
      type: "object",
      required: ["name", "kind", "value"],
      properties: {
        name: {
          $ref: "#/definitions/MetricName",
        },
        kind: {
          $ref: "#/definitions/MetricKind",
        },
        value: {
          type: "number",
        },
      },
    },
    Metrics: {
      title: "MetricsMessage",
      description:
        "정해진 주기마다 보냅니다. 보낼 값이 없어도 빈 묶음을 보내며, 이것이 heartbeat입니다.",
      type: "object",
      required: ["type", "seq", "ts", "values"],
      properties: {
        type: {
          const: "metrics",
        },
        seq: {
          $ref: "#/definitions/Seq",
        },
        ts: {
          $ref: "#/definitions/Timestamp",
        },
        values: {
          type: "array",
          items: {
            $ref: "#/definitions/MetricValue",
          },
        },
      },
    },
    EventLevel: {
      title: "EventLevel",
      enum: ["info", "warn", "error"],
    },
    Event: {
      title: "EventMessage",
      description:
        "일어나자마자 보냅니다. 같은 이벤트가 쏟아지면 SDK가 묶어서 count로 보냅니다.",
      type: "object",
      required: ["type", "seq", "ts", "level", "name", "count"],
      properties: {
        type: {
          const: "event",
        },
        seq: {
          $ref: "#/definitions/Seq",
        },
        ts: {
          $ref: "#/definitions/Timestamp",
        },
        level: {
          $ref: "#/definitions/EventLevel",
        },
        name: {
          description:
            "exception(예외), state(상태 전환), 그 밖에 개발자가 정의한 이벤트 이름입니다.",
          type: "string",
          minLength: 1,
        },
        message: {
          type: "string",
        },
        count: {
          description: "묶어서 보낸 횟수입니다. 한 건이면 1입니다.",
          type: "integer",
          minimum: 1,
        },
        data: {
          description: "이벤트별 추가 정보입니다. 예: errorType, route, stack",
          type: "object",
          additionalProperties: true,
        },
      },
    },
    Response: {
      title: "ResponseMessage",
      description:
        "서버의 request에 대한 답입니다. 실패하면 ok를 false로 두고 error에 이유를 적습니다.",
      type: "object",
      required: ["type", "seq", "ts", "replyTo", "ok"],
      properties: {
        type: {
          const: "response",
        },
        seq: {
          $ref: "#/definitions/Seq",
        },
        ts: {
          $ref: "#/definitions/Timestamp",
        },
        replyTo: {
          description: "답하는 request의 id입니다.",
          type: "string",
          minLength: 1,
        },
        ok: {
          type: "boolean",
        },
        data: {
          description:
            "성공했을 때의 결과입니다. 모양은 request의 action에 따라 다릅니다(snapshot은 snapshot.schema.json).",
          type: "object",
          additionalProperties: true,
        },
        error: {
          description: "실패한 이유입니다.",
          type: "string",
          minLength: 1,
        },
      },
      if: {
        properties: {
          ok: {
            const: false,
          },
        },
      },
      then: {
        required: ["error"],
      },
    },
  },
};

// schema/server-message.schema.json
export const serverMessageSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ServerMessage",
  description:
    "서버가 SDK로 보내는 메시지입니다(design.md 7.3). 공통 필드는 type 하나뿐입니다.",
  type: "object",
  required: ["type"],
  discriminator: {
    propertyName: "type",
  },
  oneOf: [
    {
      $ref: "#/definitions/Welcome",
    },
    {
      $ref: "#/definitions/Reject",
    },
    {
      $ref: "#/definitions/Request",
    },
    {
      $ref: "#/definitions/Heartbeat",
    },
  ],
  definitions: {
    Welcome: {
      title: "WelcomeMessage",
      description:
        "hello를 받아들였을 때 보냅니다. 보내는 주기와 한도를 서버가 정합니다.",
      type: "object",
      required: ["type", "metricsIntervalMs", "maxEventsPerMinute"],
      properties: {
        type: {
          const: "welcome",
        },
        metricsIntervalMs: {
          description: "metrics를 보내는 주기(ms)입니다.",
          type: "integer",
          minimum: 1,
        },
        maxEventsPerMinute: {
          description:
            "1분에 보낼 수 있는 event 수입니다. 넘으면 SDK가 같은 이벤트를 묶습니다.",
          type: "integer",
          minimum: 0,
        },
        heartbeatIntervalMs: {
          description:
            "서버가 heartbeat를 보내는 주기(ms)입니다. SDK는 서버 메시지가 이 주기의 3배 동안 없으면 연결이 죽은 것으로 보고 다시 붙습니다. 없으면 서버가 heartbeat를 보내지 않는 것이므로 SDK는 이 판단을 하지 않습니다.",
          type: "integer",
          minimum: 1,
        },
      },
    },
    Reject: {
      title: "RejectMessage",
      description:
        "hello를 거절할 때 보냅니다. 보낸 뒤 서버는 연결을 닫습니다.",
      type: "object",
      required: ["type", "reason"],
      properties: {
        type: {
          const: "reject",
        },
        reason: {
          description: "거절 이유입니다. 예: unknown-pod",
          type: "string",
          minLength: 1,
        },
      },
    },
    Request: {
      title: "RequestMessage",
      description:
        "정보 조회 요청입니다. 앱 상태를 바꾸는 요청은 만들지 않습니다.",
      type: "object",
      required: ["type", "id", "action"],
      properties: {
        type: {
          const: "request",
        },
        id: {
          description:
            "요청 id입니다. SDK는 response의 replyTo에 그대로 넣습니다.",
          type: "string",
          minLength: 1,
        },
        action: {
          description:
            "요청 종류입니다. v1은 snapshot 하나입니다. 모르는 action이면 SDK는 ok를 false로 답합니다.",
          type: "string",
          minLength: 1,
        },
      },
    },
    Heartbeat: {
      title: "HeartbeatMessage",
      description:
        "welcome 뒤 heartbeatIntervalMs마다 보냅니다. SDK가 응답 없는 연결(반쯤 열린 연결)을 알아채게 하려는 것이고, SDK는 답하지 않습니다.",
      type: "object",
      required: ["type"],
      properties: {
        type: {
          const: "heartbeat",
        },
      },
    },
  },
};

// schema/snapshot.schema.json
export const snapshotDataSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "SnapshotData",
  description:
    "snapshot 요청에 대한 답(response의 data)입니다(design.md 7.3). 서버는 validateSnapshotData로 검증합니다.",
  type: "object",
  required: ["state", "inFlight", "process"],
  properties: {
    state: {
      description: '등록된 상태 값입니다. 예: { "app.mode": "draining" }',
      type: "object",
      additionalProperties: {
        type: "string",
      },
    },
    inFlight: {
      description:
        "진행 중인 요청과 경과 시간입니다. 시작한 순서(경과 시간이 긴 것부터)로 적습니다.",
      type: "array",
      items: {
        type: "object",
        required: ["route", "elapsedMs"],
        properties: {
          route: {
            description:
              "요청의 라우트 모양입니다(예: GET /orders/:id). 라우트가 정해지기 전이면 메서드만 씁니다(예: GET). 실제 경로는 id와 개인 정보가 들어갈 수 있어 쓰지 않습니다.",
            type: "string",
          },
          elapsedMs: {
            description: "요청이 시작된 뒤 지난 시간(ms)입니다.",
            type: "number",
            minimum: 0,
          },
        },
      },
    },
    process: {
      description: "프로세스 정보입니다.",
      type: "object",
      required: ["uptimeSec", "heapUsedBytes"],
      properties: {
        uptimeSec: {
          description: "프로세스가 시작된 뒤 지난 시간(초)입니다.",
          type: "number",
          minimum: 0,
        },
        heapUsedBytes: {
          description: "JavaScript 힙 사용량(바이트)입니다.",
          type: "integer",
          minimum: 0,
        },
      },
    },
  },
};
