import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function BaseIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function FeedbackBugIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M8.5 8.5a3.5 3.5 0 0 1 7 0v6a3.5 3.5 0 0 1-7 0v-6Z" />
      <path d="M7 11h10" />
      <path d="M9 5.5 7.25 3.75" />
      <path d="m15 5.5 1.75-1.75" />
      <path d="M5 9.5h3.5" />
      <path d="M15.5 9.5H19" />
      <path d="M5 14.5h3.5" />
      <path d="M15.5 14.5H19" />
      <path d="M10.5 17.5v-9" />
      <path d="M13.5 17.5v-9" />
    </BaseIcon>
  );
}

export function FeedbackQuestionIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M9.75 9.25a2.4 2.4 0 0 1 4.65.85c0 1.75-2.1 2.2-2.1 3.65" />
      <path d="M12 17h.01" />
    </BaseIcon>
  );
}

export function FeedbackIdeaIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M8.25 10.75a3.75 3.75 0 1 1 7.5 0c0 1.35-.68 2.35-1.45 3.1-.6.58-.95 1.17-.95 2.02h-2.7c0-.85-.35-1.44-.95-2.02-.77-.75-1.45-1.75-1.45-3.1Z" />
      <path d="M10.35 18.5h3.3" />
      <path d="M10.9 21h2.2" />
      <path d="M12 3v2" />
      <path d="m18.25 5.75-1.4 1.4" />
      <path d="M5.75 5.75 7.15 7.15" />
    </BaseIcon>
  );
}

export function FeedbackPerformanceIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M4.75 14.5a7.25 7.25 0 1 1 14.5 0" />
      <path d="M12 14.5 16 9" />
      <path d="M7.5 14.5h9" />
      <path d="M12 5.75v1.5" />
      <path d="M6.85 8.15l1.05 1.05" />
      <path d="M17.15 8.15 16.1 9.2" />
    </BaseIcon>
  );
}
