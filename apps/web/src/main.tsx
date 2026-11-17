// 웹 화면의 진입점입니다. 주소는 브라우저 History API로 나눕니다(React Router).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
// 글꼴 파일입니다(docs/guides/T18.md 결정 21). Pretendard는 화면에 쓰인 글자의 조각만 받는 판(dynamic subset)입니다.
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "@fontsource-variable/manrope";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("index.html has no #root element");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
