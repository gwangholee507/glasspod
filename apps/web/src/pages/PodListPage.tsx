// Pod 목록 자리입니다. 목록 API(T14)가 생기기 전이라 namespace와 이름으로 상세를 여는 입력 칸만 둡니다.
import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router";

export function PodListPage() {
  const navigate = useNavigate();
  const [namespace, setNamespace] = useState("");
  const [name, setName] = useState("");
  const ready = namespace.trim() !== "" && name.trim() !== "";

  function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) {
      return;
    }
    navigate(
      `/pods/${encodeURIComponent(namespace.trim())}/${encodeURIComponent(name.trim())}`,
    );
  }

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-deep-teal">Pod 목록</h1>
        <p className="text-slate-600">
          서버의 목록 API가 생기면 Deployment별 Pod가 여기에 나옵니다. 지금은
          namespace와 Pod 이름으로 상세를 엽니다.
        </p>
      </div>

      <form
        onSubmit={open}
        className="flex flex-wrap items-end gap-3 rounded-lg border border-mist bg-white p-4"
      >
        <label className="flex flex-col gap-1 text-sm text-slate-600">
          namespace
          <input
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
            placeholder="glasspod-demo"
            className="w-56 rounded-md border border-slate-300 px-3 py-1.5 font-mono text-slate-800 focus:border-glass-cyan focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-600">
          Pod 이름
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="demo-1"
            className="w-56 rounded-md border border-slate-300 px-3 py-1.5 font-mono text-slate-800 focus:border-glass-cyan focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={!ready}
          className="rounded-md bg-deep-teal px-4 py-1.5 text-sm font-medium text-white hover:bg-deep-teal/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          상세 열기
        </button>
      </form>
    </section>
  );
}
