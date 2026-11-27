// 화면 주소입니다. 모든 화면은 분할 화면 틀(Shell) 안에 그리고, 오른쪽 자리만 주소로 바뀝니다(docs/guides/T18.md 결정 4).
import { Route, Routes } from "react-router";
import { ActionsPage } from "./pages/ActionsPage.js";
import { IsolatedPage } from "./pages/IsolatedPage.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { PodDetailPage } from "./pages/PodDetailPage.js";
import { RulesPage } from "./pages/RulesPage.js";
import { Shell } from "./shell/Shell.js";

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<OverviewPage />} />
        <Route path="pods/:namespace/:name" element={<PodDetailPage />} />
        {/* 조치 기록은 가운데 목록 칸 없이 넓게 씁니다(docs/guides/T21.md 결정 19). */}
        <Route path="actions" element={<ActionsPage />} />
        {/* 격리된 Pod도 가운데 목록 칸 없이 넓게 씁니다(docs/guides/T23.md 결정 18). */}
        <Route path="isolated" element={<IsolatedPage />} />
        {/* 자동 규칙도 가운데 목록 칸 없이 넓게 씁니다(docs/guides/T28.md 결정 2). */}
        <Route path="rules" element={<RulesPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
