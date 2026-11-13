// 화면 주소입니다. 모든 화면은 공통 틀(Layout) 안에 그립니다.
import { Route, Routes } from "react-router";
import { Layout } from "./Layout.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";
import { PodDetailPage } from "./pages/PodDetailPage.js";
import { PodListPage } from "./pages/PodListPage.js";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<PodListPage />} />
        <Route path="pods/:namespace/:name" element={<PodDetailPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
