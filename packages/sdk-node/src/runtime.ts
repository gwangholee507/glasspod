// SDK가 스스로 모으는 runtime.* 지표입니다(design.md 5.1, docs/guides/T05.md 'runtime 지표').
// 연결된 동안에만 돌고, collect()를 부를 때마다 지난 collect() 뒤의 값을 돌려줍니다.
import type { MetricValue } from "@glasspod/protocol";
import { totalmem } from "node:os";
import { createHistogram, performance } from "node:perf_hooks";
import type {
  EventLoopUtilization,
  RecordableHistogram,
} from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { guard } from "./guard.js";

// 이벤트 루프 지연을 재는 타이머 간격입니다. 이보다 긴 막힘은 모두 잡힙니다.
// monitorEventLoopDelay를 쓰지 않는 이유는 docs/guides/T05.md '측정 방식 비교'에 있습니다.
export const LAG_INTERVAL_MS = 20;

export class RuntimeSampler {
  private timer: ReturnType<typeof setInterval> | undefined;
  // 이벤트 루프 지연(마이크로초)입니다. collect()마다 비웁니다.
  private readonly lag: RecordableHistogram = createHistogram();
  // 지연 타이머가 마지막으로 깨어난 시각(performance.now(), ms)입니다. 비울 때도 지우지 않습니다.
  private lastTick = 0;
  // 지난 collect() 때의 이벤트 루프 사용률 누적값입니다.
  private elu: EventLoopUtilization | undefined;
  // 힙 상한과 컨테이너 메모리 한도는 시작할 때 한 번 읽습니다.
  private heapLimit = 0;
  private memoryLimit: number | undefined;

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    this.stop();
    this.lag.reset();
    this.elu = performance.eventLoopUtilization();
    this.heapLimit = getHeapStatistics().heap_size_limit;
    this.memoryLimit = readMemoryLimit();
    this.lastTick = performance.now();
    const timer = setInterval(() => guard(() => this.tick()), LAG_INTERVAL_MS);
    // SDK 타이머가 앱 종료를 막지 않게 합니다.
    timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // 지난 collect()(또는 start()) 뒤의 값을 모으고 지연 기록을 비웁니다.
  collect(): MetricValue[] {
    const values: MetricValue[] = [];
    const gauge = (name: string, value: number): void => {
      values.push({ name, kind: "gauge", value });
    };
    const counter = (name: string, value: number): void => {
      values.push({ name, kind: "counter", value });
    };

    // 지연 표본이 없으면(주기가 타이머 간격보다 짧은 경우 등) 지연 값은 보내지 않습니다.
    if (this.lag.count > 0) {
      gauge("runtime.event_loop.lag_p50_ms", toMs(this.lag.percentile(50)));
      gauge("runtime.event_loop.lag_p99_ms", toMs(this.lag.percentile(99)));
      gauge("runtime.event_loop.lag_max_ms", toMs(this.lag.max));
    }
    this.lag.reset();

    const elu = performance.eventLoopUtilization();
    if (this.elu !== undefined) {
      const { utilization } = performance.eventLoopUtilization(elu, this.elu);
      gauge("runtime.event_loop.utilization", round(utilization, 4));
    }
    this.elu = elu;

    const memory = process.memoryUsage();
    gauge("runtime.heap.used_bytes", memory.heapUsed);
    gauge("runtime.heap.total_bytes", memory.heapTotal);
    gauge("runtime.heap.limit_bytes", this.heapLimit);
    gauge("runtime.memory.rss_bytes", memory.rss);
    if (this.memoryLimit !== undefined) {
      gauge("runtime.memory.limit_bytes", this.memoryLimit);
    }

    const cpu = process.cpuUsage();
    counter("runtime.cpu.user_ms", cpu.user / 1000);
    counter("runtime.cpu.system_ms", cpu.system / 1000);
    return values;
  }

  // 타이머가 예정보다 늦게 깨어난 시간이 이벤트 루프 지연입니다.
  private tick(): void {
    const now = performance.now();
    const lateMs = now - this.lastTick - LAG_INTERVAL_MS;
    this.lastTick = now;
    // 히스토그램은 1 이상의 정수만 받으므로 마이크로초로 반올림하고 최소 1로 둡니다.
    this.lag.record(Math.max(1, Math.round(lateMs * 1000)));
  }
}

// 컨테이너(cgroup) 메모리 한도입니다. 0이거나 기계의 전체 메모리 이상이면 한도가 없는 것으로 봅니다.
// cgroup v2에서 한도가 없으면(max) 매우 큰 수가 나옵니다.
function readMemoryLimit(): number | undefined {
  const limit = process.constrainedMemory();
  return limit > 0 && limit < totalmem() ? limit : undefined;
}

// 마이크로초를 밀리초로 바꿉니다(소수 셋째 자리까지).
function toMs(us: number): number {
  return us / 1000;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
