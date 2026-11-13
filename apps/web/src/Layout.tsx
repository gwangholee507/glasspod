// 모든 화면의 공통 틀입니다. 위에 로고와 메뉴, 아래에 각 화면(Outlet)을 그립니다.
import { Link, NavLink, Outlet } from "react-router";

export function Layout() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-mist bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-8 px-4 py-3 sm:px-6">
          <Link to="/" className="flex items-center gap-2">
            <img src="/logo.svg" alt="" className="size-8" />
            <span className="font-brand text-xl font-medium text-deep-teal">
              glasspod
            </span>
          </Link>
          <nav className="text-sm">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                isActive
                  ? "rounded-md bg-mist px-3 py-1.5 font-medium text-deep-teal"
                  : "rounded-md px-3 py-1.5 text-slate-600 hover:text-deep-teal"
              }
            >
              Pod 목록
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
