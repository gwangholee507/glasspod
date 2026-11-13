// 정해지지 않은 주소입니다.
import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <section className="space-y-3">
      <h1 className="text-2xl font-semibold text-deep-teal">없는 화면입니다</h1>
      <p className="text-slate-600">주소를 확인해 주세요.</p>
      <Link to="/" className="inline-block text-glass-cyan hover:underline">
        Pod 목록으로
      </Link>
    </section>
  );
}
