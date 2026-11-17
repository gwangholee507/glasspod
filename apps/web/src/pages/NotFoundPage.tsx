// 정해지지 않은 주소입니다. 분할 화면의 오른쪽 자리에 그립니다.
import { Link } from "react-router";
import { overviewLink, useShell } from "../shell/shellContext.js";

export function NotFoundPage() {
  const { namespace } = useShell();
  return (
    <section className="space-y-3 px-6 py-8 lg:px-8">
      <h1 className="text-[22px] font-bold text-slate-900">없는 화면입니다</h1>
      <p className="text-slate-600">주소를 확인해 주세요.</p>
      <Link
        to={overviewLink(namespace)}
        className="inline-block text-glass-cyan hover:underline"
      >
        한눈에 보기로
      </Link>
    </section>
  );
}
