// 화면에 쓰는 작은 선 아이콘입니다(docs/guides/T18.md 결정 22). 글자 색(currentColor)을 따르고, 크기는 className으로 정합니다.
import type { ReactNode } from "react";

function Icon({
  className,
  children,
}: {
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ?? "size-4"}
    >
      {children}
    </svg>
  );
}

interface IconProps {
  className?: string;
}

// 메뉴의 Pod(목록)
export function ListIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </Icon>
  );
}

// 메뉴의 격리된 Pod(밖으로 빼기)
export function IsolateIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" />
    </Icon>
  );
}

// 메뉴의 조치 기록(되돌아보기)
export function HistoryIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2" />
    </Icon>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </Icon>
  );
}

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  );
}

export function ChevronRightIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M9 6l6 6-6 6" />
    </Icon>
  );
}

export function ChevronLeftIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M15 6l-6 6 6 6" />
    </Icon>
  );
}

// 판단 변화 타임라인
export function ClockIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Icon>
  );
}

// Deployment(Pod 묶음)
export function HexagonIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    </Icon>
  );
}

// 재시작, 다시 받기(한 바퀴 돌기)
export function RotateIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" />
    </Icon>
  );
}

// snapshot(사진 찍기)
export function CameraIcon({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </Icon>
  );
}
