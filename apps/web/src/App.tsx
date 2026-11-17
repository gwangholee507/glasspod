// 화면 주소입니다. 모든 화면은 분할 화면 틀(Shell) 안에 그리고, 오른쪽 자리만 주소로 바뀝니다(docs/guides/T18.md 결정 4).
import { Route, Routes } from "react-router";
import { NotFoundPage } from "./pages/NotFoundPage.js";
import { OverviewPage } from "./pages/OverviewPage.js";
import { PodDetailPage } from "./pages/PodDetailPage.js";
import { Shell } from "./shell/Shell.js";

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<OverviewPage />} />
        <Route path="pods/:namespace/:name" element={<PodDetailPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
